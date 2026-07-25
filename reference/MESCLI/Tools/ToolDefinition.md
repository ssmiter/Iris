using System.Text.Json.Nodes;

namespace AIGateway.Tools;

public class ToolDefinition
{
    public string Type { get; set; } = "function";
    public FunctionDefinition Function { get; set; } = new();
}

public class FunctionDefinition
{
    public string Name { get; set; } = string.Empty;
    public string Description { get; set; } = string.Empty;
    public JsonObject Parameters { get; set; } = new();

    /// <summary>
    /// OpenAI/Anthropic structured-output strict mode.
    /// </summary>
    public bool? Strict { get; set; }

    /// <summary>
    /// Anthropic defer_loading beta flag.
    /// </summary>
    public bool? DeferLoading { get; set; }
}
