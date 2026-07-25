using AIGateway.Middleware;
using AIGateway.Models;
using AIGateway.Services;
using Microsoft.AspNetCore.Mvc;

namespace AIGateway.Controllers;

[ApiController]
[Route("api/[controller]")]
public class CapabilitiesController : ControllerBase
{
    private readonly CapabilityService _capabilityService;
    private readonly ILogger<CapabilitiesController> _logger;

    public CapabilitiesController(CapabilityService capabilityService, ILogger<CapabilitiesController> logger)
    {
        _capabilityService = capabilityService;
        _logger = logger;
    }

    /// <summary>
    /// 获取后端暴露的能力目录（工具、特性、版本）。
    /// </summary>
    [HttpGet]
    public ActionResult<CapabilitiesResponse> Get(string language = "zh", string? systemCode = null)
    {
        var user = HttpContext.GetRequiredUserIdentity();
        var effectiveSystemCode = DomainCatalog.ResolveEffectiveSystemCode(user.SystemCode, systemCode);

        _logger.LogInformation("Capabilities requested: language={Language}, systemCode={SystemCode}, user={UserId}",
            language, effectiveSystemCode, user.UserId);

        return _capabilityService.GetCapabilities(language, effectiveSystemCode);
    }

    /// <summary>
    /// 文件系统式能力浏览：列出指定路径下的目录与工具入口。 http://localhost:5001/api/capabilities/tree?systemCode=sls
    /// </summary>
    [HttpGet("tree")]
    public ActionResult<CapabilityTreeResponse> GetTree(string? path = "/", string language = "zh", string? systemCode = null)
    {
        var user = HttpContext.GetRequiredUserIdentity();
        var effectiveSystemCode = DomainCatalog.ResolveEffectiveSystemCode(user.SystemCode, systemCode);

        _logger.LogInformation("Capability tree requested: path={Path}, systemCode={SystemCode}, user={UserId}",
            path, effectiveSystemCode, user.UserId);

        return _capabilityService.GetTree(path, language, effectiveSystemCode);
    }

    /// <summary>
    /// 读取指定路径工具的完整 schema。 http://localhost:5001/api/capabilities/schema?systemCode=sls&path=/sls/sls_plan_list
    /// </summary>
    [HttpGet("schema")]
    public ActionResult<CapabilitySchemaResponse> GetSchema(string path, string language = "zh", string? systemCode = null)
    {
        var user = HttpContext.GetRequiredUserIdentity();
        var effectiveSystemCode = DomainCatalog.ResolveEffectiveSystemCode(user.SystemCode, systemCode);

        _logger.LogInformation("Capability schema requested: path={Path}, systemCode={SystemCode}, user={UserId}",
            path, effectiveSystemCode, user.UserId);

        var schema = _capabilityService.GetSchema(path, language, effectiveSystemCode);
        if (schema == null)
        {
            return NotFound(new { error = $"路径 {path} 不存在或当前模式无权访问。" });
        }

        return schema;
    }
}
