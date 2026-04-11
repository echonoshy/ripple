"""Hello Bundled Skill

简单的问候技能，用于测试 bundled skills 系统。
"""

from ripple.skills.registry import register_bundled_skill

HELLO_PROMPT = """# Hello Skill

This is a bundled hello skill for testing the skill system.

Hello from bundled skill! This skill is compiled into Ripple and available to all users.

If you provided arguments, here they are: $ARGUMENTS

This demonstrates that bundled skills work correctly.
"""


def register_hello_skill():
    """注册 hello 技能"""
    register_bundled_skill(
        name="hello-bundled",
        description="A bundled hello skill for testing",
        content=HELLO_PROMPT,
        allowed_tools=["Bash", "Read"],
        arguments=["name"],
        when_to_use="When you want to test the bundled skill system",
    )
