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

    def resolve_model(self, name_or_alias: str) -> str:
        """解析模型名称或别名为完整模型 ID

        如果 name_or_alias 匹配 presets 中的别名，返回对应的模型 ID；
        否则原样返回。

        Args:
            name_or_alias: 模型名称或预设别名

        Returns:
            完整模型 ID
        """
        presets = self.get("model.presets", {})
        if presets and name_or_alias in presets:
            return presets[name_or_alias].get("model", name_or_alias)
        return name_or_alias

    def get_model_presets(self) -> dict[str, dict]:
        """获取所有模型预设

        Returns:
            预设字典 {别名: {model, description}}
        """
        return self.get("model.presets", {}) or {}

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
