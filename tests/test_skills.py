"""测试 Skill 系统

测试 bundled skills 和 fork 模式。
"""

from ripple.skills.loader import get_global_loader


def test_bundled_skills():
    """测试 bundled skills 加载"""
    loader = get_global_loader()
    skills = loader.list_skills()

    print(f"✓ 加载了 {len(skills)} 个 skills")

    # 检查 bundled skills
    bundled_skills = [s for s in skills if s.file_path.startswith("<bundled:")]
    print(f"✓ 其中 {len(bundled_skills)} 个是 bundled skills")

    # 列出所有 skills
    print("\n所有 Skills:")
    for skill in skills:
        source = "bundled" if skill.file_path.startswith("<bundled:") else "file"
        print(f"  - {skill.name} ({source}): {skill.description}")

    # 测试特定 skills
    hello_bundled = loader.get_skill("hello-bundled")
    assert hello_bundled is not None, "hello-bundled skill 应该存在"
    assert hello_bundled.file_path == "<bundled:hello-bundled>"
    print(f"\n✓ hello-bundled skill 加载成功")

    simplify = loader.get_skill("simplify")
    assert simplify is not None, "simplify skill 应该存在"
    assert simplify.file_path == "<bundled:simplify>"
    assert simplify.is_all_tools_allowed, "simplify 应该允许所有工具"
    print(f"✓ simplify skill 加载成功")

    # 测试文件系统 skills
    hello_file = loader.get_skill("hello")
    if hello_file:
        print(f"✓ hello (file) skill 加载成功: {hello_file.file_path}")
    else:
        print("  (没有找到 hello 文件 skill)")

    print("\n✓ 所有测试通过！")


def test_skill_content():
    """测试 skill 内容和参数替换"""
    loader = get_global_loader()

    # 测试 hello-bundled
    hello = loader.get_skill("hello-bundled")
    assert hello is not None

    # 测试参数替换
    content = hello.substitute_arguments("World")
    assert "World" in content or "WORLD" in content
    print(f"✓ 参数替换测试通过")

    # 测试 simplify 内容
    simplify = loader.get_skill("simplify")
    assert simplify is not None
    assert "Code Review" in simplify.content
    assert "git diff" in simplify.content
    print(f"✓ Simplify 内容验证通过")


if __name__ == "__main__":
    print("=" * 60)
    print("测试 Skill 系统")
    print("=" * 60)

    test_bundled_skills()
    print()
    test_skill_content()

    print("\n" + "=" * 60)
    print("所有测试完成！")
    print("=" * 60)
