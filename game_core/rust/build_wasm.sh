cd "$(dirname "$0")/vantage_core"
cargo build --release --target wasm32-unknown-unknown
mkdir -p ../../js/wasm
cp target/wasm32-unknown-unknown/release/vantage_core.wasm ../../js/wasm/vantage_core.wasm
