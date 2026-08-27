package com.iris.agent.model;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * Tool Observation micro-compact 行为参数。
 * 这些值是待标定的初值，应根据真实对话数据调整；
 * 仅影响后续 attempt 的上下文投影，不删除历史。
 */
@ConfigurationProperties(prefix = "iris.agent.micro-compact")
public class ToolObservationMicroCompactProperties {

    /** 最近若干条可重取 Tool Observation 必须保留原文，不受 micro-compact 影响。 */
    private int keepRecent = 6;

    /** 触发 micro-compact 的上下文 token 占可用输入预算比例上限。 */
    private double triggerRatio = 0.70;

    /** micro-compact 要努力收敛到的上下文 token 占可用输入预算比例上限。 */
    private double targetRatio = 0.60;

    public int getKeepRecent() {
        return keepRecent;
    }

    public void setKeepRecent(int keepRecent) {
        this.keepRecent = keepRecent;
    }

    public double getTriggerRatio() {
        return triggerRatio;
    }

    public void setTriggerRatio(double triggerRatio) {
        this.triggerRatio = triggerRatio;
    }

    public double getTargetRatio() {
        return targetRatio;
    }

    public void setTargetRatio(double targetRatio) {
        this.targetRatio = targetRatio;
    }
}
