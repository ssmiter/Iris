package com.iris.extension;

/**
 * 一件被遮蔽的拓展能力（docs/31 §5.2 + docs/32 §3）：冲突件不注册，
 * 但管理页可见、可寻址；模型目录不出现。
 *
 * @param root           来源拓展根（绝对路径）
 * @param name           能力名
 * @param capabilityPath 能力路径
 * @param kind           process | template | skill | knowledge
 * @param description    发现用一句话
 * @param file           来源文件绝对路径（清单 / SKILL.md / 知识文档）
 * @param shadowedBy     胜出者来源（{@code local-java} / provider key）
 */
public record ShadowedCapability(
        String root,
        String name,
        String capabilityPath,
        String kind,
        String description,
        String file,
        String shadowedBy
) {
}
