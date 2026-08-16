import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.math.BigDecimal;
import java.math.MathContext;
import java.math.RoundingMode;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * calculate 常驻插件（docs/31 §4）：确定性十进制算术，不执行脚本或
 * 调用宿主 eval。单文件源码启动，无第三方依赖。
 *
 * <p>语义与内核历史版本 DecimalExpressionEvaluator 一致：MathContext
 * HALF_EVEN、运算步数与渲染规模上限、错误码同形。</p>
 */
public class Calculate {

    private static final int DEFAULT_PRECISION = 34;
    private static final int MAX_PRECISION = 100;
    private static final int MAX_EXPRESSION_CHARACTERS = 1_000;
    private static final int MAX_OPERATIONS = 10_000;
    private static final int MAX_ABSOLUTE_EXPONENT = 10_000;
    private static final int MAX_RENDERED_DIGITS = 15_000;

    public static void main(String[] args) throws Exception {
        BufferedReader in = new BufferedReader(new InputStreamReader(
                System.in, StandardCharsets.UTF_8));
        BufferedWriter out = new BufferedWriter(new OutputStreamWriter(
                System.out, StandardCharsets.UTF_8));
        String line;
        while ((line = in.readLine()) != null) {
            if (line.isBlank()) {
                continue;
            }
            Object frame;
            try {
                frame = Json.parse(line);
            } catch (RuntimeException parseFailure) {
                continue;
            }
            if (!(frame instanceof Map<?, ?> message)) {
                continue;
            }
            if (!"invoke".equals(message.get("type"))) {
                continue; // cancel 帧在调用间隙生效；内核超时三层兜底
            }
            String callId = message.get("callId") instanceof String text
                    ? text : null;
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("type", "result");
            result.put("callId", callId);
            try {
                Map<?, ?> input = message.get("input")
                        instanceof Map<?, ?> map ? map : Map.of();
                String expression = input.get("expression")
                        instanceof String text ? text.trim() : "";
                int precision = input.get("precision") instanceof Number number
                        ? number.intValue() : DEFAULT_PRECISION;
                if (precision < 1 || precision > MAX_PRECISION) {
                    throw new CalcFailure(
                            "calculation_precision_out_of_range",
                            "precision 必须在 1 到 100 之间");
                }
                BigDecimal value = evaluate(expression, precision);
                Map<String, Object> structured = new LinkedHashMap<>();
                structured.put("result", format(value));
                structured.put("precision", BigDecimal.valueOf(precision));
                structured.put("rounding", "HALF_EVEN");
                result.put("success", true);
                result.put("data", format(value));
                result.put("structuredData", structured);
            } catch (CalcFailure failure) {
                result.put("success", false);
                Map<String, Object> error = new LinkedHashMap<>();
                error.put("code", failure.code);
                error.put("message", failure.getMessage());
                result.put("error", error);
            }
            out.write(Json.write(result));
            out.newLine();
            out.flush();
        }
    }

    private static String format(BigDecimal value) {
        if (value.signum() == 0) {
            return "0";
        }
        return value.stripTrailingZeros().toPlainString();
    }

    static BigDecimal evaluate(String expression, int precision) {
        if (expression == null || expression.isBlank()) {
            throw new CalcFailure(
                    "invalid_calculation_expression", "计算表达式不能为空");
        }
        if (expression.length() > MAX_EXPRESSION_CHARACTERS) {
            throw new CalcFailure("invalid_calculation_expression",
                    "计算表达式不能超过 1000 个字符");
        }
        ExpressionParser parser = new ExpressionParser(
                expression, new MathContext(precision, RoundingMode.HALF_EVEN));
        BigDecimal result = parser.parseExpression();
        parser.skipWhitespace();
        if (!parser.atEnd()) {
            throw parser.error("存在无法识别的字符");
        }
        return result;
    }

    private static final class CalcFailure extends RuntimeException {
        final String code;

        CalcFailure(String code, String message) {
            super(message);
            this.code = code;
        }
    }

    private static final class ExpressionParser {

        private final String expression;
        private final MathContext context;
        private int position;
        private int operations;

        ExpressionParser(String expression, MathContext context) {
            this.expression = expression;
            this.context = context;
        }

        BigDecimal parseExpression() {
            BigDecimal value = parseTerm();
            while (true) {
                if (consume('+')) {
                    value = bounded(value.add(parseTerm(), context));
                    operation();
                } else if (consume('-')) {
                    value = bounded(value.subtract(parseTerm(), context));
                    operation();
                } else {
                    return value;
                }
            }
        }

        private BigDecimal parseTerm() {
            BigDecimal value = parseUnary();
            while (true) {
                if (consume('*')) {
                    value = bounded(value.multiply(parseUnary(), context));
                    operation();
                } else if (consume('/')) {
                    BigDecimal divisor = parseUnary();
                    if (divisor.signum() == 0) {
                        throw new CalcFailure(
                                "calculation_division_by_zero", "除数不能为 0");
                    }
                    value = bounded(value.divide(divisor, context));
                    operation();
                } else if (consume('%')) {
                    BigDecimal divisor = parseUnary();
                    if (divisor.signum() == 0) {
                        throw new CalcFailure("calculation_division_by_zero",
                                "余数运算的除数不能为 0");
                    }
                    value = bounded(value.remainder(divisor, context));
                    operation();
                } else {
                    return value;
                }
            }
        }

        private BigDecimal parseUnary() {
            if (consume('+')) {
                return parseUnary();
            }
            if (consume('-')) {
                return parseUnary().negate(context);
            }
            return parsePower();
        }

        private BigDecimal parsePower() {
            BigDecimal base = parsePrimary();
            if (!consume('^')) {
                return base;
            }
            BigDecimal exponentValue = parseUnary();
            int exponent;
            try {
                exponent = exponentValue.intValueExact();
            } catch (ArithmeticException failure) {
                throw new CalcFailure("calculation_exponent_not_integer",
                        "幂运算的指数必须是整数");
            }
            if (Math.abs((long) exponent) > MAX_ABSOLUTE_EXPONENT) {
                throw new CalcFailure("calculation_exponent_too_large",
                        "幂运算指数的绝对值不能超过 10000");
            }
            operation();
            if (exponent >= 0) {
                return bounded(base.pow(exponent, context));
            }
            if (base.signum() == 0) {
                throw new CalcFailure(
                        "calculation_division_by_zero", "0 不能使用负指数");
            }
            return bounded(BigDecimal.ONE.divide(
                    base.pow(-exponent, context), context));
        }

        private BigDecimal parsePrimary() {
            if (consume('(')) {
                BigDecimal value = parseExpression();
                if (!consume(')')) {
                    throw error("缺少右括号");
                }
                return value;
            }
            return parseNumber();
        }

        private BigDecimal parseNumber() {
            skipWhitespace();
            int start = position;
            boolean digits = false;
            while (!atEnd() && Character.isDigit(current())) {
                position++;
                digits = true;
            }
            if (!atEnd() && current() == '.') {
                position++;
                while (!atEnd() && Character.isDigit(current())) {
                    position++;
                    digits = true;
                }
            }
            if (!digits) {
                throw error("此处需要数字或左括号");
            }
            if (!atEnd() && (current() == 'e' || current() == 'E')) {
                int exponentMarker = position++;
                if (!atEnd() && (current() == '+' || current() == '-')) {
                    position++;
                }
                int exponentDigits = position;
                while (!atEnd() && Character.isDigit(current())) {
                    position++;
                }
                if (position == exponentDigits) {
                    position = exponentMarker;
                    throw error("科学计数法的指数不完整");
                }
            }
            try {
                return bounded(new BigDecimal(
                        expression.substring(start, position), context));
            } catch (NumberFormatException failure) {
                throw error("数字格式无效");
            }
        }

        private boolean consume(char expected) {
            skipWhitespace();
            if (!atEnd() && current() == expected) {
                position++;
                return true;
            }
            return false;
        }

        private void operation() {
            operations++;
            if (operations > MAX_OPERATIONS) {
                throw error("表达式运算步骤超过上限");
            }
        }

        private BigDecimal bounded(BigDecimal value) {
            if (value.signum() == 0) {
                return value;
            }
            long scale = value.scale();
            long integerDigits = (long) value.precision() - scale;
            if (scale > MAX_RENDERED_DIGITS
                    || scale < -MAX_RENDERED_DIGITS
                    || integerDigits > MAX_RENDERED_DIGITS) {
                throw new CalcFailure("calculation_result_too_large",
                        "计算结果超出可安全呈现的十进制范围");
            }
            return value;
        }

        private void skipWhitespace() {
            while (!atEnd() && Character.isWhitespace(current())) {
                position++;
            }
        }

        private char current() {
            return expression.charAt(position);
        }

        private boolean atEnd() {
            return position >= expression.length();
        }

        private CalcFailure error(String detail) {
            return new CalcFailure("invalid_calculation_expression",
                    detail + "（位置 " + (position + 1) + "）");
        }
    }

    /**
     * 最小 JSON 编解码（对象/数组/字符串/数字/布尔/null）。
     * 数字一律解析为 BigDecimal，保证十进制语义不漂。
     */
    static final class Json {

        static Object parse(String text) {
            Parser parser = new Parser(text);
            Object value = parser.parseValue();
            parser.skipWhitespace();
            if (!parser.atEnd()) {
                throw new IllegalArgumentException("JSON 尾部有多余字符");
            }
            return value;
        }

        static String write(Object value) {
            StringBuilder out = new StringBuilder();
            writeValue(value, out);
            return out.toString();
        }

        private static void writeValue(Object value, StringBuilder out) {
            if (value == null) {
                out.append("null");
            } else if (value instanceof String text) {
                writeString(text, out);
            } else if (value instanceof Number || value instanceof Boolean) {
                out.append(value.toString());
            } else if (value instanceof Map<?, ?> map) {
                out.append('{');
                boolean first = true;
                for (Map.Entry<?, ?> entry : map.entrySet()) {
                    if (!first) {
                        out.append(',');
                    }
                    first = false;
                    writeString(String.valueOf(entry.getKey()), out);
                    out.append(':');
                    writeValue(entry.getValue(), out);
                }
                out.append('}');
            } else if (value instanceof List<?> list) {
                out.append('[');
                boolean first = true;
                for (Object element : list) {
                    if (!first) {
                        out.append(',');
                    }
                    first = false;
                    writeValue(element, out);
                }
                out.append(']');
            } else {
                writeString(String.valueOf(value), out);
            }
        }

        private static void writeString(String text, StringBuilder out) {
            out.append('"');
            for (int i = 0; i < text.length(); i++) {
                char c = text.charAt(i);
                switch (c) {
                    case '"' -> out.append("\\\"");
                    case '\\' -> out.append("\\\\");
                    case '\n' -> out.append("\\n");
                    case '\r' -> out.append("\\r");
                    case '\t' -> out.append("\\t");
                    default -> {
                        if (c < 0x20) {
                            out.append(String.format("\\u%04x", (int) c));
                        } else {
                            out.append(c);
                        }
                    }
                }
            }
            out.append('"');
        }

        private static final class Parser {
            private final String text;
            private int position;

            Parser(String text) {
                this.text = text;
            }

            Object parseValue() {
                skipWhitespace();
                if (atEnd()) {
                    throw new IllegalArgumentException("JSON 意外结束");
                }
                char c = text.charAt(position);
                return switch (c) {
                    case '{' -> parseObject();
                    case '[' -> parseArray();
                    case '"' -> parseString();
                    case 't' -> literal("true", Boolean.TRUE);
                    case 'f' -> literal("false", Boolean.FALSE);
                    case 'n' -> literal("null", null);
                    default -> parseNumber();
                };
            }

            private Map<String, Object> parseObject() {
                Map<String, Object> map = new LinkedHashMap<>();
                position++; // '{'
                skipWhitespace();
                if (!atEnd() && text.charAt(position) == '}') {
                    position++;
                    return map;
                }
                while (true) {
                    skipWhitespace();
                    String key = parseString();
                    skipWhitespace();
                    expect(':');
                    map.put(key, parseValue());
                    skipWhitespace();
                    if (!atEnd() && text.charAt(position) == ',') {
                        position++;
                        continue;
                    }
                    expect('}');
                    return map;
                }
            }

            private List<Object> parseArray() {
                List<Object> list = new ArrayList<>();
                position++; // '['
                skipWhitespace();
                if (!atEnd() && text.charAt(position) == ']') {
                    position++;
                    return list;
                }
                while (true) {
                    list.add(parseValue());
                    skipWhitespace();
                    if (!atEnd() && text.charAt(position) == ',') {
                        position++;
                        continue;
                    }
                    expect(']');
                    return list;
                }
            }

            private String parseString() {
                expect('"');
                StringBuilder value = new StringBuilder();
                while (!atEnd()) {
                    char c = text.charAt(position++);
                    if (c == '"') {
                        return value.toString();
                    }
                    if (c == '\\') {
                        if (atEnd()) {
                            break;
                        }
                        char escape = text.charAt(position++);
                        switch (escape) {
                            case '"' -> value.append('"');
                            case '\\' -> value.append('\\');
                            case '/' -> value.append('/');
                            case 'n' -> value.append('\n');
                            case 'r' -> value.append('\r');
                            case 't' -> value.append('\t');
                            case 'b' -> value.append('\b');
                            case 'f' -> value.append('\f');
                            case 'u' -> {
                                value.append((char) Integer.parseInt(
                                        text.substring(position, position + 4),
                                        16));
                                position += 4;
                            }
                            default -> throw new IllegalArgumentException(
                                    "非法转义: \\" + escape);
                        }
                    } else {
                        value.append(c);
                    }
                }
                throw new IllegalArgumentException("字符串未闭合");
            }

            private BigDecimal parseNumber() {
                int start = position;
                while (!atEnd()) {
                    char c = text.charAt(position);
                    if ((c >= '0' && c <= '9') || c == '-' || c == '+'
                            || c == '.' || c == 'e' || c == 'E') {
                        position++;
                    } else {
                        break;
                    }
                }
                if (start == position) {
                    throw new IllegalArgumentException(
                            "此处需要 JSON 值（位置 " + position + "）");
                }
                try {
                    return new BigDecimal(text.substring(start, position));
                } catch (NumberFormatException failure) {
                    throw new IllegalArgumentException("数字格式无效", failure);
                }
            }

            private Object literal(String word, Object value) {
                if (text.startsWith(word, position)) {
                    position += word.length();
                    return value;
                }
                throw new IllegalArgumentException(
                        "无法识别的字面量（位置 " + position + "）");
            }

            private void expect(char expected) {
                if (atEnd() || text.charAt(position) != expected) {
                    throw new IllegalArgumentException(
                            "期望 '" + expected + "'（位置 " + position + "）");
                }
                position++;
            }

            void skipWhitespace() {
                while (!atEnd()
                        && Character.isWhitespace(text.charAt(position))) {
                    position++;
                }
            }

            boolean atEnd() {
                return position >= text.length();
            }
        }
    }
}
