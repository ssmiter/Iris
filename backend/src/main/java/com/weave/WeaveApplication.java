package com.weave;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/**
 * Weave 个人助手后端。
 * 分层：proxy（模型代理）/ tools（工具平台）/ workspace（文件围栏+检查点）/
 *       sandbox（Python）/ history（会话持久化）/ config（运行时配置）。
 * 设计文档见 ../docs，改架构先改文档。
 */
@SpringBootApplication
public class WeaveApplication {
    public static void main(String[] args) {
        SpringApplication.run(WeaveApplication.class, args);
    }
}
