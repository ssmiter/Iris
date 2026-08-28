package com.iris.tools.core;

import java.util.List;
import java.util.stream.Collectors;

/**
 * 工具路由对照的单一事实源（docs/42 §4 P1 第 7 条）。
 *
 * <p>系统提示词的「工具路由」一节与进程类工具规约里的旁路提醒都由同一份
 * 路由数据渲染，禁止两处各写一份会漂移的拷贝。对照写具体工具名而非抽象
 * 原则：旁路（shell cat、脚本改写文件等）会绕过审批粒度、路径围栏与
 * 结果裁剪。</p>
 */
public final class ToolRoutingGuide {

    /**
     * 一条路由：高频动作 → 专用工具（及典型旁路形态）。
     * processBypass 为 true 表示进程/脚本类工具也能代做该动作，
     * 其规约面需要点名提醒。
     */
    public record Route(
            String need,
            String tool,
            String bypass,
            boolean processBypass
    ) {
    }

    private static final List<Route> ROUTES = List.of(
            new Route("读取文件内容", "read_file", "cat、type 或脚本读文件", true),
            new Route("查看目录结构", "list_files", "dir、ls", true),
            new Route("定位文件或搜索文本", "search_files", "find、grep", true),
            new Route("局部修改文件", "apply_patch", "sed 或脚本改写", true),
            new Route("整体创建或重写文件", "write_file", "重定向写文件", true),
            new Route("新建目录", "make_directory", "mkdir", true),
            new Route("续读超长工具结果", "read_tool_result、query_tool_result",
                    "重复发起同一昂贵调用", false)
    );

    private ToolRoutingGuide() {
    }

    /** 系统提示词的「工具路由」整节，含并行调用规约。 */
    public static String systemPromptSection() {
        String lines = ROUTES.stream()
                .map(route -> "- " + route.need() + " → " + route.tool()
                        + "（不要用 " + route.bypass() + "）")
                .collect(Collectors.joining("\n"));
        return """
                ## 工具路由
                高频动作一律使用专用工具，不经 shell、进程或脚本旁路——旁路绕过审批粒度、路径围栏与结果裁剪。
                %s
                无依赖的多个调用在同一条消息里并行发出；只有参数依赖或写入顺序要求才串行。""".formatted(lines);
    }

    /**
     * 进程类工具规约面（TemplateProcessTool/ResidentProcessTool 的 manifest
     * prompt）统一追加的旁路提醒，与系统提示词同源。
     */
    public static String processToolReminder() {
        String tools = ROUTES.stream()
                .filter(Route::processBypass)
                .map(Route::tool)
                .collect(Collectors.joining("、"));
        return "进程旁路边界：本工具不做文件读写与搜索的代理——这些动作优先使用专用工具（"
                + tools
                + "），进程旁路会绕过审批粒度、路径围栏与结果裁剪。";
    }
}
