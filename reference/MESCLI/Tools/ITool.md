using System.Text.Json.Nodes;

namespace AIGateway.Tools;

public interface ITool
{
    string Name { get; }
    string Description { get; }
    string DescriptionEn => Description;
    ToolDefinition Parameters { get; }
    Task<ToolResult> InvokeAsync(JsonObject args, ToolContext ctx);
}
