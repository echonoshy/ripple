"""配置管理模块"""

from pathlib import Path
from typing import Any

import yaml


class Config:
    """配置管理类"""

    def __init__(self, config_path: str | Path | None = None):
        """初始化配置

        Args:
            config_path: 配置文件路径，默认为项目根目录的 config/settings.yaml
        """
        if config_path is None:
            # 查找项目根目录
            current = Path.cwd()
            while current != current.parent:
                config_file = current / "config" / "settings.yaml"
                if config_file.exists():
                    config_path = config_file
                    break
                current = current.parent

            if config_path is None:
                raise FileNotFoundError(
                    "找不到配置文件 config/settings.yaml。请在项目根目录创建 config/settings.yaml 文件。"
                )

        self.config_path = Path(config_path)
        self._data = self._load_config()

    def _load_config(self) -> dict[str, Any]:
        """加载配置文件"""
        with open(self.config_path, encoding="utf-8") as f:
            return yaml.safe_load(f) or {}

    def get(self, key: str, default: Any = None) -> Any:
        """获取配置值

        支持点号分隔的嵌套键，例如 "api.api_key"

        Args:
            key: 配置键
            default: 默认值

        Returns:
            配置值
        """
        keys = key.split(".")
        value = self._data
        for k in keys:
            if isinstance(value, dict):
                value = value.get(k)
            else:
                return default
            if value is None:
                return default
        return value

    def get_current_provider(self) -> str:
        """获取当前启用的 API provider 名称

        优先读取 `api.provider`；若未配置但有老式 `api.base_url`，返回 "openrouter"（兼容旧配置）。
        """
        provider = self.get("api.provider")
        if provider:
            return provider
        if self.get("api.base_url") or self.get("api.api_key"):
            return "openrouter"
        return "openrouter"

    def get_provider_config(self, name: str | None = None) -> dict[str, Any]:
        """获取指定 provider 的配置

        Args:
            name: provider 名称，None 表示使用当前 provider

        Returns:
            {"type": "openai"|"anthropic", "api_key": ..., "base_url": ...}
        """
        if name is None:
            name = self.get_current_provider()

        providers = self.get("api.providers", {}) or {}
        if name in providers:
            cfg = dict(providers[name])
            cfg.setdefault("type", "openai")
            return cfg

        # 回退：如果没有新的 providers 配置，把老的 api.api_key/api.base_url 当作 openrouter
        legacy_key = self.get("api.api_key")
        legacy_url = self.get("api.base_url", "https://openrouter.ai/api/v1")
        if legacy_key:
            return {"type": "openai", "api_key": legacy_key, "base_url": legacy_url}

        raise ValueError(f"Provider '{name}' 未在配置文件中找到，请检查 config/settings.yaml 的 api.providers")

    def resolve_model(self, name_or_alias: str, provider: str | None = None) -> str:
        """解析模型名称或别名为完整模型 ID

        查找顺序：
        1. **别名直接命中**：`name_or_alias` 就是 presets 的 key（如 "sonnet"）
           → 取 `presets[alias][provider]`，回退到 `presets[alias]["model"]`
        2. **反向查找（跨 provider 重映射）**：`name_or_alias` 已经是某个 provider 的全限定 model ID
           （比如 "anthropic/claude-sonnet-4.6" 来自 OpenRouter 旧 session、或 Web 前端缓存）
           → 在所有 presets 中找出它归属的别名，再换算到当前 provider 的值
        3. **兜底**：原样返回

        这样可以保证：切 provider 后，老持久化 session 里带的 OpenRouter 格式 model ID
        也能被自动重映射到万界的格式，不需要手动清 session。

        Args:
            name_or_alias: 模型名称或预设别名
            provider: provider 名称，默认使用当前 provider

        Returns:
            完整模型 ID
        """
        if provider is None:
            provider = self.get_current_provider()

        presets = self.get("model.presets", {}) or {}

        # 1. 别名直接命中
        if name_or_alias in presets:
            preset = presets[name_or_alias] or {}
            if isinstance(preset, dict):
                if provider in preset:
                    return preset[provider]
                if "model" in preset:
                    return preset["model"]

        # 2. 反向查找：看 name_or_alias 是否是某个 preset 下某个 provider 的值
        for preset in presets.values():
            if not isinstance(preset, dict):
                continue
            matched = False
            for p_name, p_value in preset.items():
                if p_name == "model":
                    # 旧结构的 fallback 也参与匹配
                    if p_value == name_or_alias:
                        matched = True
                        break
                    continue
                if p_value == name_or_alias:
                    matched = True
                    break
            if matched:
                if provider in preset:
                    return preset[provider]
                if "model" in preset:
                    return preset["model"]
                break

        # 3. 原样返回
        return name_or_alias

    def get_model_presets(self) -> dict[str, dict]:
        """获取所有模型预设

        Returns:
            预设字典 {别名: {provider: model_id, ...}} 或 {别名: {model: ...}}
        """
        return self.get("model.presets", {}) or {}

    def alias_for_model(self, model_id: str, provider: str | None = None) -> str | None:
        """反向查找：给定一个模型 ID，返回它在 presets 里的别名（如果有）

        用于把存储层的 raw model ID（如 "claude-sonnet-4-6" 或
        "anthropic/claude-sonnet-4.6"）反映射回 "sonnet" 这样的别名，
        便于前端 UI 下拉框匹配。

        Args:
            model_id: 完整模型 ID
            provider: 可选，限定只匹配某个 provider 的条目

        Returns:
            别名；找不到返回 None
        """
        presets = self.get("model.presets", {}) or {}
        for alias, preset in presets.items():
            if not isinstance(preset, dict):
                continue
            for p_name, p_value in preset.items():
                if provider is not None and p_name != provider:
                    continue
                if p_value == model_id:
                    return alias
        return None

    def presets_for_provider(self, provider: str | None = None) -> dict[str, str]:
        """返回当前（或指定）provider 下 `alias -> model_id` 的扁平映射

        用于对外 API（如 /v1/info）展示模型预设。

        Args:
            provider: 可选，指定 provider 名称

        Returns:
            {alias: resolved_model_id}
        """
        if provider is None:
            provider = self.get_current_provider()

        presets = self.get("model.presets", {}) or {}
        out: dict[str, str] = {}
        for alias, preset in presets.items():
            if not isinstance(preset, dict):
                continue
            if provider in preset:
                out[alias] = preset[provider]
            elif "model" in preset:
                out[alias] = preset["model"]
        return out

    def reload(self):
        """重新加载配置文件"""
        self._data = self._load_config()


# 全局配置实例
_config: Config | None = None


def get_config(config_path: str | Path | None = None) -> Config:
    """获取全局配置实例

    Args:
        config_path: 配置文件路径

    Returns:
        配置实例
    """
    global _config
    if _config is None:
        _config = Config(config_path)
    return _config
