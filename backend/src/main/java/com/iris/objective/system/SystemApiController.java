package com.iris.objective.system;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * 系统端点（WonWork 契约 /api/auth/user、/api/version，docs/46）。
 *
 * <p>Iris 单用户本地，无登录/鉴权：/api/auth/user 返回固定的本地用户事实；
 * /api/version 返回应用版本事实。只读。</p>
 */
@RestController
@RequestMapping("/api")
public class SystemApiController {

    private final String appVersion;

    public SystemApiController(
            @Value("${iris.app-version:0.1.0}") String appVersion
    ) {
        this.appVersion = appVersion;
    }

    /** GET /api/auth/user —— 本地单用户事实（WonWork UserInfo 形状的可简版）。 */
    @GetMapping("/auth/user")
    public Map<String, Object> currentUser() {
        return Map.of(
                "userId", 1,
                "userName", "local",
                "realName", "Local User",
                "systemCode", "local"
        );
    }

    /** GET /api/version —— 应用版本事实。 */
    @GetMapping("/version")
    public Map<String, Object> version() {
        return Map.of(
                "version", appVersion,
                "downloadUrl", "",
                "releaseNotes", "",
                "mandatory", false
        );
    }
}
