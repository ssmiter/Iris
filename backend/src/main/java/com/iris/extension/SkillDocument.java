package com.iris.extension;

/**
 * SKILL.md 的 frontmatter/正文拆分（docs/31 §5.1）。扫描器校验与
 * {@link SkillTool} 运行时读取共用同一套切分，避免两处漂移。
 */
final class SkillDocument {

    private SkillDocument() {
    }

    /**
     * 拆出 frontmatter YAML 与正文。返回 {@code [frontmatter, body]}；
     * 文件不以 {@code ---} 行开合 frontmatter 时返回 null（fail-closed）。
     */
    static String[] split(String content) {
        if (content == null) {
            return null;
        }
        String[] lines = content.split("\r?\n", -1);
        if (lines.length == 0 || !"---".equals(lines[0].trim())) {
            return null;
        }
        StringBuilder frontmatter = new StringBuilder();
        for (int index = 1; index < lines.length; index++) {
            if ("---".equals(lines[index].trim())) {
                StringBuilder body = new StringBuilder();
                for (int rest = index + 1; rest < lines.length; rest++) {
                    body.append(lines[rest]);
                    if (rest + 1 < lines.length) {
                        body.append('\n');
                    }
                }
                return new String[]{frontmatter.toString(), body.toString()};
            }
            frontmatter.append(lines[index]).append('\n');
        }
        return null;
    }
}
