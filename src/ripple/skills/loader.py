"""Skill 加载器

从目录加载 Skill 定义，并合并 bundled skills。

只有满足以下条件之一的 .md 文件才会被加载为 Skill：
1. 文件名为 SKILL.md（推荐的入口文件命名）
2. 文件包含有效的 YAML frontmatter 且含有 name 或 description 字段

支持三层加载模式（后者覆盖前者）：
1. Bundled Skills  — 内置 Python 硬编码
2. Shared Skills   — server.shared_skills_dirs 配置的全局共享目录
3. Workspace Skills — 每个 session 的 workspace/skills/（沙箱内）
"""

from pathlib import Path

import frontmatter

from ripple.skills.registry import get_bundled_skills
from ripple.skills.types import Skill
from ripple.utils.logger import get_logger

logger = get_logger("skills.loader")

SKILL_ENTRY_FILENAME = "SKILL.md"
WORKSPACE_SKILLS_DIRNAME = "skills"


def _load_skill_file(file_path: Path) -> Skill | None:
    """从文件加载 Skill

    只加载满足条件的文件：
    - 文件名为 SKILL.md
    - 或含有效 frontmatter（有 name 或 description 字段）

    非入口 .md 文件（如 README.md、references 文档）会被跳过。
    """
    with open(file_path, encoding="utf-8") as f:
        post = frontmatter.load(f)

    metadata = post.metadata
    content = post.content

    is_entry_file = file_path.name == SKILL_ENTRY_FILENAME
    has_skill_metadata = bool(metadata.get("name") or metadata.get("description"))

    if not is_entry_file and not has_skill_metadata:
        return None

    name = metadata.get("name", file_path.stem)

    return Skill(
        name=name,
        description=metadata.get("description", ""),
        content=content,
        file_path=str(file_path),
        allowed_tools=_parse_allowed_tools(metadata.get("allowed-tools", [])),
        arguments=metadata.get("arguments", []),
        context=metadata.get("context", "inline"),
        hooks=metadata.get("hooks", {}),
        model=metadata.get("model"),
        effort=metadata.get("effort"),
        when_to_use=metadata.get("when-to-use") or metadata.get("when_to_use"),
        version=metadata.get("version"),
    )


def _parse_allowed_tools(allowed_tools: list[str] | str) -> list[str]:
    """解析 allowed-tools 字段"""
    if isinstance(allowed_tools, str):
        if allowed_tools.lower() == "all":
            return ["__all__"]
        return [allowed_tools]
    elif isinstance(allowed_tools, list):
        return allowed_tools
    else:
        return []


def _load_skills_from_dir(skill_dir: Path) -> dict[str, Skill]:
    """从单个目录递归加载 skill 文件"""
    skills: dict[str, Skill] = {}
    if not skill_dir.exists():
        return skills
    for skill_file in skill_dir.rglob("*.md"):
        try:
            skill = _load_skill_file(skill_file)
            if skill:
                skills[skill.name] = skill
        except Exception as e:
            logger.warning("跳过无法加载的 Skill 文件 {}: {}", skill_file, e)
    return skills


class SkillLoader:
    """Skill 加载器

    从 Markdown 文件加载 Skill 定义。
    """

    def __init__(self, skill_dirs: list[str] | None = None):
        """初始化加载器

        Args:
            skill_dirs: Skill 目录列表，默认为 ["skills"]
        """
        if skill_dirs is None:
            skill_dirs = ["skills"]
        self.skill_dirs = [Path(d).expanduser() for d in skill_dirs]
        self._skills: dict[str, Skill] = {}

    def load_all(self) -> dict[str, Skill]:
        """加载所有 Skill

        加载顺序：
        1. Bundled skills（内置技能）
        2. 文件系统 skills（用户技能）

        后加载的覆盖先加载的（文件系统 skills 可以覆盖 bundled skills）

        Returns:
            Skill 字典（name -> Skill）
        """
        self._skills.clear()

        bundled_skills = get_bundled_skills()
        self._skills.update(bundled_skills)

        for skill_dir in self.skill_dirs:
            self._skills.update(_load_skills_from_dir(skill_dir))

        return self._skills

    def get_skill(self, name: str) -> Skill | None:
        """获取 Skill"""
        return self._skills.get(name)

    def list_skills(self) -> list[Skill]:
        """列出所有 Skill"""
        return list(self._skills.values())


_global_loader: SkillLoader | None = None


def get_global_loader() -> SkillLoader:
    """获取全局 Skill 加载器

    首次调用时会注册所有 bundled skills 并加载所有 skills。
    """
    global _global_loader
    if _global_loader is None:
        from ripple.skills.bundled import register_all_bundled_skills

        register_all_bundled_skills()

        _global_loader = SkillLoader()
        _global_loader.load_all()
    return _global_loader


def reload_skills():
    """重新加载所有 Skill"""
    global _global_loader
    if _global_loader:
        _global_loader.load_all()


# ---------------------------------------------------------------------------
# Shared skills (Server 级别共享，所有 session 可见)
# ---------------------------------------------------------------------------

_shared_skills_cache: tuple[dict[str, Skill], float] | None = None


def _get_shared_skill_dirs() -> list[Path]:
    """从配置读取共享 skill 目录列表"""
    from ripple.utils.config import get_config

    config = get_config()
    dirs = config.get("skills.shared_dirs", [])
    return [Path(d).expanduser().resolve() for d in dirs]


def _compute_dirs_mtime(dirs: list[Path]) -> float:
    """计算多个目录的聚合 mtime（取最大值）"""
    mtime = 0.0
    for d in dirs:
        try:
            if d.exists():
                mtime = max(mtime, d.stat().st_mtime)
        except OSError:
            pass
    return mtime


def load_shared_skills() -> dict[str, Skill]:
    """加载共享 skills（bundled + shared_dirs）

    Server 模式下用于 schema 生成、/v1/info、system prompt 等场景。
    使用目录 mtime 做轻量缓存。

    Returns:
        合并后的 skill 字典（name -> Skill）
    """
    global _shared_skills_cache

    from ripple.skills.bundled import register_all_bundled_skills

    register_all_bundled_skills()

    shared_dirs = _get_shared_skill_dirs()
    current_mtime = _compute_dirs_mtime(shared_dirs)

    if _shared_skills_cache is not None:
        cached_skills, cached_mtime = _shared_skills_cache
        if cached_skills and current_mtime == cached_mtime and current_mtime > 0:
            return cached_skills

    merged: dict[str, Skill] = {}
    merged.update(get_bundled_skills())
    for d in shared_dirs:
        merged.update(_load_skills_from_dir(d))

    _shared_skills_cache = (merged, current_mtime)
    if merged:
        logger.debug("共享 skills 加载了 {} 个（来自 {} 个目录）", len(merged), len(shared_dirs))

    return merged


def invalidate_shared_cache() -> None:
    """清除共享 skill 缓存"""
    global _shared_skills_cache
    _shared_skills_cache = None


# ---------------------------------------------------------------------------
# Per-workspace skill loading (Server per-session 模式)
# ---------------------------------------------------------------------------

_workspace_skills_cache: dict[Path, tuple[float, dict[str, Skill]]] = {}


def load_workspace_skills(workspace_root: Path) -> dict[str, Skill]:
    """加载指定 workspace 的完整 skills（bundled + shared + workspace/skills/）

    三层合并，后者覆盖前者：
    1. Bundled skills
    2. Shared skills（来自 skills.shared_dirs 配置）
    3. Workspace skills（session 沙箱内的 workspace/skills/）

    使用目录 mtime 做轻量缓存，避免每次工具调用都做磁盘扫描。

    Returns:
        合并后的 skill 字典（name -> Skill）
    """
    skills_dir = workspace_root / WORKSPACE_SKILLS_DIRNAME

    cached_mtime, cached_skills = _workspace_skills_cache.get(workspace_root, (0.0, {}))
    try:
        current_mtime = skills_dir.stat().st_mtime if skills_dir.exists() else 0.0
    except OSError:
        current_mtime = 0.0

    if cached_skills and current_mtime == cached_mtime and current_mtime > 0:
        return cached_skills

    merged: dict[str, Skill] = {}
    merged.update(load_shared_skills())
    merged.update(_load_skills_from_dir(skills_dir))

    _workspace_skills_cache[workspace_root] = (current_mtime, merged)
    if merged:
        logger.debug("workspace {} 加载了 {} 个 skills", workspace_root, len(merged))

    return merged


def invalidate_workspace_cache(workspace_root: Path) -> None:
    """清除指定 workspace 的 skill 缓存"""
    _workspace_skills_cache.pop(workspace_root, None)
