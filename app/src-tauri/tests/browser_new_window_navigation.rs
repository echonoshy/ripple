#[test]
fn browser_webview_installs_new_window_navigation_interceptor() {
    let browser_source = include_str!("../src/browser.rs");

    assert!(
        browser_source.contains(".initialization_script(browser_new_window_navigation_script())"),
        "browser webview should install the new-window navigation interceptor"
    );
    assert!(
        browser_source.contains("window.open"),
        "interceptor should override window.open to navigate in the current webview"
    );
    assert!(
        browser_source.contains("target === \"_blank\""),
        "interceptor should catch links that explicitly target a new window"
    );
    assert!(
        browser_source.contains("event.preventDefault()"),
        "interceptor should cancel the default new-window click before navigating"
    );
}
