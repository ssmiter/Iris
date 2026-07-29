package com.iris.sql;

import com.iris.sql.SqlConnectionProvider.AccessMode;
import com.iris.sql.SqlConnectionProvider.Dialect;
import org.springframework.boot.context.properties.ConfigurationProperties;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 本机 SQL adapter 配置。URL 与凭据只存在于本地配置和 provider，
 * 不进入 Capability Definition 或模型上下文。
 */
@ConfigurationProperties(prefix = "iris.sql")
public class IrisSqlProperties {

    private Map<String, ConnectionSettings> connections =
            new LinkedHashMap<>();

    public Map<String, ConnectionSettings> getConnections() {
        return connections;
    }

    public void setConnections(
            Map<String, ConnectionSettings> connections
    ) {
        this.connections = connections == null
                ? new LinkedHashMap<>()
                : new LinkedHashMap<>(connections);
    }

    public static class ConnectionSettings {
        private String title;
        private String description;
        private Dialect dialect = Dialect.GENERIC;
        private AccessMode accessMode = AccessMode.READ_ONLY;
        private String url;
        private String username;
        private String password;
        private Map<String, String> properties = new LinkedHashMap<>();

        public String getTitle() {
            return title;
        }

        public void setTitle(String title) {
            this.title = title;
        }

        public String getDescription() {
            return description;
        }

        public void setDescription(String description) {
            this.description = description;
        }

        public Dialect getDialect() {
            return dialect;
        }

        public void setDialect(Dialect dialect) {
            this.dialect = dialect;
        }

        public AccessMode getAccessMode() {
            return accessMode;
        }

        public void setAccessMode(AccessMode accessMode) {
            this.accessMode = accessMode;
        }

        public String getUrl() {
            return url;
        }

        public void setUrl(String url) {
            this.url = url;
        }

        public String getUsername() {
            return username;
        }

        public void setUsername(String username) {
            this.username = username;
        }

        public String getPassword() {
            return password;
        }

        public void setPassword(String password) {
            this.password = password;
        }

        public Map<String, String> getProperties() {
            return properties;
        }

        public void setProperties(Map<String, String> properties) {
            this.properties = properties == null
                    ? new LinkedHashMap<>()
                    : new LinkedHashMap<>(properties);
        }
    }
}
