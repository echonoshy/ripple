"""错误处理工具"""


class RippleError(Exception):
    """Ripple 基础异常"""

    pass


class ToolExecutionError(RippleError):
    """工具执行错误"""

    def __init__(self, tool_name: str, message: str, original_error: Exception | None = None):
        self.tool_name = tool_name
        self.original_error = original_error
        super().__init__(f"Tool '{tool_name}' execution failed: {message}")


class PermissionDeniedError(RippleError):
    """权限被拒绝错误"""

    def __init__(self, tool_name: str, message: str):
        self.tool_name = tool_name
        super().__init__(f"Permission denied for tool '{tool_name}': {message}")


class ValidationError(RippleError):
    """输入验证错误"""

    pass


class APIError(RippleError):
    """API 调用错误"""

    def __init__(self, message: str, status_code: int | None = None):
        self.status_code = status_code
        super().__init__(message)


class MaxOutputTokensError(APIError):
    """最大输出 token 错误"""

    pass


class PromptTooLongError(APIError):
    """提示过长错误"""

    pass


def error_message(error: Exception) -> str:
    """提取错误消息"""
    return str(error) if error else "Unknown error"
