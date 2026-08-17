package com.iris.schedule;

/** 任务创建/变更/启停/删除后发布，唤醒器据此重排下一次苏醒。 */
public record CronScheduleChangedEvent(String taskId) { }
