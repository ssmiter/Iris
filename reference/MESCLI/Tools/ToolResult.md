using System.Text.Json.Nodes;

namespace AIGateway.Tools;

public class ToolResult
{
    public bool Success { get; set; }
    public string Data { get; set; } = string.Empty;
    public string? Error { get; set; }
    public JsonNode? StructuredData { get; set; }

    public static ToolResult Ok(string data) => new() { Success = true, Data = data };
    public static ToolResult Ok(string data, JsonNode structuredData) => new() { Success = true, Data = data, StructuredData = structuredData };
    public static ToolResult Fail(string error) => new() { Success = false, Error = error, Data = error };
}
