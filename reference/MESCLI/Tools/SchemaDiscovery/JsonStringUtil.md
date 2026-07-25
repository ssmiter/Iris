namespace AIGateway.Tools.SchemaDiscovery;

public static class JsonStringUtil
{
    /// <summary>
    /// 移除字符串中会导致 System.Text.Json 序列化失败的字符：
    /// U+0000 (NULL)、C0/C1 控制字符、孤立代理对、U+FFFE/U+FFFF。
    /// </summary>
    public static string? Sanitize(string? input)
    {
        if (string.IsNullOrEmpty(input)) return input;

        var sb = new System.Text.StringBuilder(input.Length);
        foreach (var c in input)
        {
            if (c == '\0') continue;                         // NULL
            if (c >= 0x80 && c <= 0x9F) continue;            // C1 控制字符
            if (c >= 0x00 && c <= 0x1F                       // C0 控制字符
                && c != '\n' && c != '\r' && c != '\t')
                continue;
            if (char.IsSurrogate(c)) continue;               // 孤立代理对
            if (c == 0xFFFE || c == 0xFFFF) continue;        // 非字符
            sb.Append(c);
        }
        return sb.ToString();
    }
}
