fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().plugin(
            "ripple-browser",
            tauri_build::InlinedPlugin::new()
                .commands(&[
                    "open",
                    "resize",
                    "navigate",
                    "reload",
                    "print_page",
                    "set_zoom",
                    "clear_data",
                    "back",
                    "forward",
                    "capture",
                    "run_automation",
                    "close",
                    "show",
                    "hide",
                ])
                .default_permission(tauri_build::DefaultPermissionRule::AllowAllCommands),
        ),
    )
    .expect("failed to build Tauri app");
}
