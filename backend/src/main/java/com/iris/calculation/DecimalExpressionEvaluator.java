package com.iris.calculation;

import com.iris.tools.core.ToolRuntimeException;
import org.springframework.stereotype.Component;

import java.math.BigDecimal;
import java.math.MathContext;
import java.math.RoundingMode;
import java.util.function.BooleanSupplier;

/**
 * 小而确定的十进制算术求值器，不执行脚本或调用宿主语言 eval。
 */
@Component
public class DecimalExpressionEvaluator {

    private static final int MAX_EXPRESSION_CHARACTERS = 1_000;
    private static final int MAX_OPERATIONS = 10_000;
    private static final int MAX_ABSOLUTE_EXPONENT = 10_000;
    private static final int MAX_RENDERED_DIGITS = 15_000;

    public BigDecimal evaluate(
            String expression,
            int precision,
            BooleanSupplier cancelled
    ) {
        if (expression == null || expression.isBlank()) {
            throw invalid("计算表达式不能为空");
        }
        if (expression.length() > MAX_EXPRESSION_CHARACTERS) {
            throw invalid("计算表达式不能超过 1000 个字符");
        }
        Parser parser = new Parser(
                expression,
                new MathContext(precision, RoundingMode.HALF_EVEN),
                cancelled == null ? () -> false : cancelled
        );
        BigDecimal result = parser.parseExpression();
        parser.skipWhitespace();
        if (!parser.atEnd()) {
            throw parser.error("存在无法识别的字符");
        }
        return result;
    }

    private ToolRuntimeException invalid(String message) {
        return new ToolRuntimeException(
                "invalid_calculation_expression",
                message
        );
    }

    private static final class Parser {

        private final String expression;
        private final MathContext context;
        private final BooleanSupplier cancelled;
        private int position;
        private int operations;

        private Parser(
                String expression,
                MathContext context,
                BooleanSupplier cancelled
        ) {
            this.expression = expression;
            this.context = context;
            this.cancelled = cancelled;
        }

        private BigDecimal parseExpression() {
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
                        throw new ToolRuntimeException(
                                "calculation_division_by_zero",
                                "除数不能为 0"
                        );
                    }
                    value = bounded(value.divide(divisor, context));
                    operation();
                } else if (consume('%')) {
                    BigDecimal divisor = parseUnary();
                    if (divisor.signum() == 0) {
                        throw new ToolRuntimeException(
                                "calculation_division_by_zero",
                                "余数运算的除数不能为 0"
                        );
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
            } catch (ArithmeticException exception) {
                throw new ToolRuntimeException(
                        "calculation_exponent_not_integer",
                        "幂运算的指数必须是整数"
                );
            }
            if (Math.abs((long) exponent) > MAX_ABSOLUTE_EXPONENT) {
                throw new ToolRuntimeException(
                        "calculation_exponent_too_large",
                        "幂运算指数的绝对值不能超过 10000"
                );
            }
            operation();
            if (exponent >= 0) {
                return bounded(base.pow(exponent, context));
            }
            if (base.signum() == 0) {
                throw new ToolRuntimeException(
                        "calculation_division_by_zero",
                        "0 不能使用负指数"
                );
            }
            return bounded(BigDecimal.ONE.divide(
                    base.pow(-exponent, context),
                    context
            ));
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
                        expression.substring(start, position),
                        context
                ));
            } catch (NumberFormatException exception) {
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
            if (cancelled.getAsBoolean()) {
                throw new ToolRuntimeException(
                        "tool_cancelled",
                        "计算已停止"
                );
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
                throw new ToolRuntimeException(
                        "calculation_result_too_large",
                        "计算结果超出可安全呈现的十进制范围"
                );
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

        private ToolRuntimeException error(String detail) {
            return new ToolRuntimeException(
                    "invalid_calculation_expression",
                    detail + "（位置 " + (position + 1) + "）"
            );
        }
    }
}
