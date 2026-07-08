fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().plugin(
            "ripple-browser",
            tauri_build::InlinedPlugin::new()
                .commands(&[
                    "open",
                    "resize",
                    "navigate",
                    "go_back",
                    "go_forward",
                    "reload",
                    "close",
                    "show",
                    "hide",
                ])
                .default_permission(tauri_build::DefaultPermissionRule::AllowAllCommands),
        ),
    )
    .expect("failed to build Tauri app");
}
