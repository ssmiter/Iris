package com.iris.agent.run;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 子任务进度摘要的共享文案：task 字段提取（含兜底）与 accepted 相位前缀。
 * 实时节点投影与 RunView 水合装配必须看到同一份结果。
 */
class ChildRunNodeProjectionServiceTest {

    private final ObjectMapper objectMapper = new ObjectMapper();

    @Test
    void taskTextFallsBackToDefaultWhenInputMissing() {
        assertThat(ChildRunNodeProjectionService.taskTextFromPipelineInput(
                objectMapper,
                null
        )).isEqualTo("后台子任务");
        assertThat(ChildRunNodeProjectionService.taskTextFromPipelineInput(
                objectMapper,
                "   "
        )).isEqualTo("后台子任务");
    }

    @Test
    void taskTextFallsBackToDefaultWhenInputIsNotValidJson() {
        assertThat(ChildRunNodeProjectionService.taskTextFromPipelineInput(
                objectMapper,
                "{not json"
        )).isEqualTo("后台子任务");
    }

    @Test
    void taskTextReadsTrimmedTaskField() {
        assertThat(ChildRunNodeProjectionService.taskTextFromPipelineInput(
                objectMapper,
                "{\"task\":\"  整理会议纪要  \"}"
        )).isEqualTo("整理会议纪要");
    }

    @Test
    void taskTextFallsBackToDefaultWhenTaskFieldBlank() {
        assertThat(ChildRunNodeProjectionService.taskTextFromPipelineInput(
                objectMapper,
                "{\"task\":\"   \"}"
        )).isEqualTo("后台子任务");
        assertThat(ChildRunNodeProjectionService.taskTextFromPipelineInput(
                objectMapper,
                "{}"
        )).isEqualTo("后台子任务");
    }

    @Test
    void acceptedPhaseGetsQueuedPrefix() {
        assertThat(ChildRunNodeProjectionService.progressSummary(
                "accepted",
                "整理会议纪要"
        )).isEqualTo("子任务已排队，等待启动：整理会议纪要");
    }

    @Test
    void otherPhasesKeepTaskTextUnchanged() {
        assertThat(ChildRunNodeProjectionService.progressSummary(
                "running",
                "整理会议纪要"
        )).isEqualTo("整理会议纪要");
        assertThat(ChildRunNodeProjectionService.progressSummary(
                "succeeded",
                "整理会议纪要"
        )).isEqualTo("整理会议纪要");
    }
}
