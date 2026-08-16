package com.iris;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/**
 * Iris 个人助手后端。
 * 分层：proxy（模型代理）/ tools（工具平台）/ workspace（文件围栏+检查点）/
 *       extension（插件目录）/ history（会话持久化）/ config（运行时配置）。
 * 设计文档见 ../docs，改架构先改文档。
 */
@SpringBootApplication
public class IrisApplication {
    public static void main(String[] args) {
        SpringApplication.run(IrisApplication.class, args);
    }
}
