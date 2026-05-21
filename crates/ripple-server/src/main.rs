#[tokio::main]
async fn main() -> anyhow::Result<()> {
    ripple_server::run().await
}
