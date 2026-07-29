package com.iris.sql;

import com.iris.sql.SqlConnectionProvider.Dialect;
import com.iris.tools.core.ToolRuntimeException;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * SQL 的保守词法分析器。
 *
 * 不执行 SQL，也不尝试成为完整方言 parser；无法证明只读时返回 AMBIGUOUS。
 */
@Component
public class SqlStatementAnalyzer {

    private static final int MAX_SQL_CHARACTERS = 100_000;
    private static final Set<String> READ_OPERATIONS = Set.of(
            "SELECT", "VALUES", "SHOW", "DESCRIBE", "DESC"
    );
    private static final Set<String> WRITE_OPERATIONS = Set.of(
            "INSERT", "UPDATE", "DELETE", "MERGE", "REPLACE",
            "CREATE", "ALTER", "DROP", "TRUNCATE", "RENAME",
            "GRANT", "REVOKE", "CALL", "EXEC", "EXECUTE",
            "VACUUM", "ANALYZE", "ATTACH", "DETACH",
            "BEGIN", "COMMIT", "ROLLBACK", "SAVEPOINT", "RELEASE"
    );
    private static final Set<String> RESOURCE_PREFIXES = Set.of(
            "FROM", "JOIN", "INTO", "UPDATE", "TABLE"
    );
    private static final Set<String> READ_ONLY_SQLITE_PRAGMAS = Set.of(
            "TABLE_INFO", "TABLE_XINFO", "INDEX_INFO", "INDEX_XINFO",
            "INDEX_LIST", "FOREIGN_KEY_LIST", "DATABASE_LIST",
            "COLLATION_LIST", "COMPILE_OPTIONS", "FUNCTION_LIST",
            "MODULE_LIST", "PRAGMA_LIST"
    );

    public Analysis analyze(String sql, Dialect dialect) {
        if (sql == null || sql.isBlank()) {
            throw new ToolRuntimeException(
                    "sql_empty",
                    "SQL 不能为空"
            );
        }
        if (sql.length() > MAX_SQL_CHARACTERS) {
            throw new ToolRuntimeException(
                    "sql_too_large",
                    "SQL 文本不能超过 10 万字符"
            );
        }
        List<Token> tokens = new Lexer(sql).scan();
        List<Token> statement = requireSingleStatement(tokens);
        if (statement.isEmpty()) {
            throw new ToolRuntimeException(
                    "sql_empty",
                    "SQL 不包含可执行语句"
            );
        }

        Operation operation = operation(statement, dialect);
        return new Analysis(
                operation.kind(),
                operation.label(),
                resources(statement),
                dialect == null ? Dialect.GENERIC : dialect,
                operation.reason()
        );
    }

    private List<Token> requireSingleStatement(List<Token> tokens) {
        int semicolon = -1;
        for (int index = 0; index < tokens.size(); index++) {
            Token token = tokens.get(index);
            if (token.depth() == 0 && token.symbol(";")) {
                if (semicolon >= 0) {
                    throw multipleStatements();
                }
                semicolon = index;
            }
        }
        if (semicolon < 0) {
            return tokens;
        }
        if (semicolon != tokens.size() - 1) {
            throw multipleStatements();
        }
        return List.copyOf(tokens.subList(0, semicolon));
    }

    private ToolRuntimeException multipleStatements() {
        return new ToolRuntimeException(
                "sql_multiple_statements",
                "一次只能执行一条 SQL 语句"
        );
    }

    private Operation operation(List<Token> tokens, Dialect dialect) {
        int first = firstTopLevelWord(tokens, 0);
        if (first < 0) {
            return ambiguous("unknown", "无法识别 SQL 的首个操作");
        }
        String keyword = tokens.get(first).upper();
        if ("WITH".equals(keyword)) {
            int main = firstOperation(tokens, first + 1);
            if (main < 0) {
                return ambiguous("with", "WITH 语句缺少可识别的主操作");
            }
            Operation cteWrite = writeInsideCte(tokens, first + 1, main);
            if (cteWrite != null) {
                return cteWrite;
            }
            return classifyKeyword(
                    tokens,
                    main,
                    tokens.get(main).upper(),
                    dialect
            );
        }
        if ("EXPLAIN".equals(keyword)) {
            if (containsTopLevelWord(tokens, first + 1, "ANALYZE")) {
                return ambiguous(
                        "explain_analyze",
                        "EXPLAIN ANALYZE 可能实际执行被分析语句"
                );
            }
            int explained = firstOperation(tokens, first + 1);
            if (explained < 0) {
                return ambiguous(
                        "explain",
                        "EXPLAIN 后缺少可识别的只读语句"
                );
            }
            Operation nested = classifyKeyword(
                    tokens,
                    explained,
                    tokens.get(explained).upper(),
                    dialect
            );
            if (nested.kind() != Kind.READ) {
                return nested;
            }
            return new Operation(
                    Kind.READ,
                    "explain",
                    "EXPLAIN 的目标语句已被确认只读"
            );
        }
        return classifyKeyword(tokens, first, keyword, dialect);
    }

    private Operation classifyKeyword(
            List<Token> tokens,
            int index,
            String keyword,
            Dialect dialect
    ) {
        if ("PRAGMA".equals(keyword)) {
            return classifyPragma(tokens, index, dialect);
        }
        if ("SELECT".equals(keyword)) {
            return classifySelect(tokens, index);
        }
        if (READ_OPERATIONS.contains(keyword)) {
            return new Operation(
                    Kind.READ,
                    keyword.toLowerCase(Locale.ROOT),
                    "操作已被词法分析器确认为只读"
            );
        }
        if (WRITE_OPERATIONS.contains(keyword)) {
            return new Operation(
                    Kind.WRITE,
                    keyword.toLowerCase(Locale.ROOT),
                    "操作可能改变数据库或事务状态"
            );
        }
        return ambiguous(
                keyword.toLowerCase(Locale.ROOT),
                "当前分析器无法证明该操作只读"
        );
    }

    private Operation classifySelect(List<Token> tokens, int selectIndex) {
        if (containsTopLevelWord(tokens, selectIndex + 1, "INTO")) {
            return new Operation(
                    Kind.WRITE,
                    "select_into",
                    "SELECT INTO 可能创建表或写入文件"
            );
        }
        for (int index = selectIndex + 1;
                index + 1 < tokens.size();
                index++) {
            Token first = tokens.get(index);
            Token second = tokens.get(index + 1);
            if (first.depth() == 0
                    && second.depth() == 0
                    && first.type() == TokenType.WORD
                    && second.type() == TokenType.WORD
                    && "FOR".equals(first.upper())
                    && ("UPDATE".equals(second.upper())
                    || "SHARE".equals(second.upper()))) {
                return ambiguous(
                        "locking_select",
                        "锁定式 SELECT 会改变数据库会话中的锁状态"
                );
            }
        }
        return new Operation(
                Kind.READ,
                "select",
                "SELECT 已排除已知写入和锁定结构"
        );
    }

    private Operation writeInsideCte(
            List<Token> tokens,
            int start,
            int mainOperation
    ) {
        for (int index = start; index < mainOperation; index++) {
            Token token = tokens.get(index);
            if (token.type() == TokenType.WORD
                    && WRITE_OPERATIONS.contains(token.upper())) {
                return new Operation(
                        Kind.WRITE,
                        "write_cte",
                        "WITH 子句包含可能改变数据库状态的 "
                                + token.upper()
                );
            }
        }
        return null;
    }

    private boolean containsTopLevelWord(
            List<Token> tokens,
            int start,
            String word
    ) {
        for (int index = start; index < tokens.size(); index++) {
            Token token = tokens.get(index);
            if (token.depth() == 0
                    && token.type() == TokenType.WORD
                    && word.equals(token.upper())) {
                return true;
            }
        }
        return false;
    }

    private Operation classifyPragma(
            List<Token> tokens,
            int pragmaIndex,
            Dialect dialect
    ) {
        if (dialect != Dialect.SQLITE) {
            return ambiguous(
                    "pragma",
                    "PRAGMA 只在声明为 SQLite 的连接上允许分析"
            );
        }
        Token name = nextName(tokens, pragmaIndex + 1);
        if (name == null
                || !READ_ONLY_SQLITE_PRAGMAS.contains(name.upper())) {
            return ambiguous(
                    "pragma",
                    "该 PRAGMA 不在只读 allowlist 中"
            );
        }
        for (int index = pragmaIndex + 1; index < tokens.size(); index++) {
            if (tokens.get(index).symbol("=")) {
                return new Operation(
                        Kind.WRITE,
                        "pragma_assignment",
                        "带赋值的 PRAGMA 可能改变连接或数据库状态"
                );
            }
        }
        return new Operation(
                Kind.READ,
                "pragma_" + name.upper().toLowerCase(Locale.ROOT),
                "该 PRAGMA 位于 SQLite 只读 allowlist"
        );
    }

    private int firstOperation(List<Token> tokens, int start) {
        for (int index = start; index < tokens.size(); index++) {
            Token token = tokens.get(index);
            if (token.depth() != 0 || token.type() != TokenType.WORD) {
                continue;
            }
            String word = token.upper();
            if (READ_OPERATIONS.contains(word)
                    || WRITE_OPERATIONS.contains(word)
                    || "PRAGMA".equals(word)
                    || "EXPLAIN".equals(word)) {
                return index;
            }
        }
        return -1;
    }

    private int firstTopLevelWord(List<Token> tokens, int start) {
        for (int index = start; index < tokens.size(); index++) {
            Token token = tokens.get(index);
            if (token.depth() == 0 && token.type() == TokenType.WORD) {
                return index;
            }
        }
        return -1;
    }

    private List<String> resources(List<Token> tokens) {
        Map<String, String> resources = new LinkedHashMap<>();
        for (int index = 0; index < tokens.size(); index++) {
            Token token = tokens.get(index);
            if (token.type() != TokenType.WORD
                    || !RESOURCE_PREFIXES.contains(token.upper())) {
                continue;
            }
            Resource resource = readResource(tokens, index + 1);
            if (resource == null || resource.name().isBlank()) {
                continue;
            }
            resources.putIfAbsent(
                    resource.name().toLowerCase(Locale.ROOT),
                    resource.name()
            );
        }
        return List.copyOf(resources.values());
    }

    private Resource readResource(List<Token> tokens, int start) {
        StringBuilder name = new StringBuilder();
        int expectedDepth = start < tokens.size()
                ? tokens.get(start).depth()
                : 0;
        for (int index = start; index < tokens.size(); index++) {
            Token token = tokens.get(index);
            if (token.depth() != expectedDepth) {
                break;
            }
            if (token.symbol("(")) {
                return null;
            }
            if (token.type() == TokenType.WORD
                    || token.type() == TokenType.IDENTIFIER) {
                name.append(token.text());
                continue;
            }
            if (token.symbol(".") && !name.isEmpty()) {
                name.append('.');
                continue;
            }
            break;
        }
        return name.isEmpty() ? null : new Resource(name.toString());
    }

    private Token nextName(List<Token> tokens, int start) {
        for (int index = start; index < tokens.size(); index++) {
            Token token = tokens.get(index);
            if (token.type() == TokenType.WORD
                    || token.type() == TokenType.IDENTIFIER) {
                return token;
            }
            if (!token.symbol(".")) {
                return null;
            }
        }
        return null;
    }

    private Operation ambiguous(String label, String reason) {
        return new Operation(Kind.AMBIGUOUS, label, reason);
    }

    public enum Kind {
        READ,
        WRITE,
        AMBIGUOUS
    }

    public record Analysis(
            Kind kind,
            String operation,
            List<String> resources,
            Dialect dialect,
            String reason
    ) {
        public Analysis {
            resources = List.copyOf(resources);
        }

        public boolean readOnlyConfirmed() {
            return kind == Kind.READ;
        }
    }

    private record Operation(Kind kind, String label, String reason) {
    }

    private record Resource(String name) {
    }

    private enum TokenType {
        WORD,
        IDENTIFIER,
        LITERAL,
        SYMBOL,
        NUMBER,
        PARAMETER
    }

    private record Token(
            TokenType type,
            String text,
            int depth,
            int position
    ) {
        private String upper() {
            return text.toUpperCase(Locale.ROOT);
        }

        private boolean symbol(String value) {
            return type == TokenType.SYMBOL && text.equals(value);
        }
    }

    private static final class Lexer {

        private final String sql;
        private final List<Token> tokens = new ArrayList<>();
        private int position;
        private int depth;

        private Lexer(String sql) {
            this.sql = sql;
        }

        private List<Token> scan() {
            while (position < sql.length()) {
                char current = sql.charAt(position);
                if (Character.isWhitespace(current)) {
                    position++;
                } else if (current == '\''
                        ) {
                    quoted('\'', TokenType.LITERAL, true);
                } else if (current == '"') {
                    quoted('"', TokenType.IDENTIFIER, true);
                } else if (current == '`') {
                    quoted('`', TokenType.IDENTIFIER, true);
                } else if (current == '[') {
                    bracketIdentifier();
                } else if (current == '-'
                        && peek(1) == '-') {
                    lineComment();
                } else if (current == '/'
                        && peek(1) == '*') {
                    blockComment();
                } else if (current == '(') {
                    tokens.add(new Token(
                            TokenType.SYMBOL, "(", depth, position++
                    ));
                    depth++;
                } else if (current == ')') {
                    if (depth == 0) {
                        throw invalid("多余的右括号", position);
                    }
                    depth--;
                    tokens.add(new Token(
                            TokenType.SYMBOL, ")", depth, position++
                    ));
                } else if (isWordStart(current)) {
                    word();
                } else if (Character.isDigit(current)) {
                    number();
                } else if (current == ':'
                        || current == '@'
                        || current == '$'
                        || current == '?') {
                    parameter();
                } else {
                    tokens.add(new Token(
                            TokenType.SYMBOL,
                            String.valueOf(current),
                            depth,
                            position++
                    ));
                }
            }
            if (depth != 0) {
                throw invalid("左括号没有闭合", sql.length());
            }
            return List.copyOf(tokens);
        }

        private void word() {
            int start = position++;
            while (position < sql.length()
                    && isWordPart(sql.charAt(position))) {
                position++;
            }
            tokens.add(new Token(
                    TokenType.WORD,
                    sql.substring(start, position),
                    depth,
                    start
            ));
        }

        private void number() {
            int start = position++;
            while (position < sql.length()) {
                char value = sql.charAt(position);
                if (!Character.isDigit(value)
                        && value != '.'
                        && value != 'e'
                        && value != 'E'
                        && value != '+'
                        && value != '-') {
                    break;
                }
                position++;
            }
            tokens.add(new Token(
                    TokenType.NUMBER,
                    sql.substring(start, position),
                    depth,
                    start
            ));
        }

        private void parameter() {
            int start = position++;
            while (position < sql.length()
                    && isWordPart(sql.charAt(position))) {
                position++;
            }
            tokens.add(new Token(
                    TokenType.PARAMETER,
                    sql.substring(start, position),
                    depth,
                    start
            ));
        }

        private void quoted(
                char delimiter,
                TokenType type,
                boolean doubledEscape
        ) {
            int start = position++;
            StringBuilder value = new StringBuilder();
            while (position < sql.length()) {
                char current = sql.charAt(position++);
                if (current != delimiter) {
                    value.append(current);
                    continue;
                }
                if (doubledEscape
                        && position < sql.length()
                        && sql.charAt(position) == delimiter) {
                    value.append(delimiter);
                    position++;
                    continue;
                }
                tokens.add(new Token(type, value.toString(), depth, start));
                return;
            }
            throw invalid("引用内容没有闭合", start);
        }

        private void bracketIdentifier() {
            int start = position++;
            StringBuilder value = new StringBuilder();
            while (position < sql.length()) {
                char current = sql.charAt(position++);
                if (current != ']') {
                    value.append(current);
                    continue;
                }
                if (position < sql.length()
                        && sql.charAt(position) == ']') {
                    value.append(']');
                    position++;
                    continue;
                }
                tokens.add(new Token(
                        TokenType.IDENTIFIER,
                        value.toString(),
                        depth,
                        start
                ));
                return;
            }
            throw invalid("方括号标识符没有闭合", start);
        }

        private void lineComment() {
            position += 2;
            while (position < sql.length()
                    && sql.charAt(position) != '\n') {
                position++;
            }
        }

        private void blockComment() {
            int start = position;
            position += 2;
            int nesting = 1;
            while (position < sql.length() && nesting > 0) {
                if (sql.charAt(position) == '/'
                        && peek(1) == '*') {
                    nesting++;
                    position += 2;
                } else if (sql.charAt(position) == '*'
                        && peek(1) == '/') {
                    nesting--;
                    position += 2;
                } else {
                    position++;
                }
            }
            if (nesting != 0) {
                throw invalid("块注释没有闭合", start);
            }
        }

        private char peek(int offset) {
            int target = position + offset;
            return target >= sql.length() ? '\0' : sql.charAt(target);
        }

        private boolean isWordStart(char value) {
            return Character.isLetter(value)
                    || value == '_'
                    || value == '#';
        }

        private boolean isWordPart(char value) {
            return Character.isLetterOrDigit(value)
                    || value == '_'
                    || value == '#';
        }

        private ToolRuntimeException invalid(String detail, int offset) {
            return new ToolRuntimeException(
                    "invalid_sql",
                    detail + "（位置 " + (offset + 1) + "）"
            );
        }
    }
}
