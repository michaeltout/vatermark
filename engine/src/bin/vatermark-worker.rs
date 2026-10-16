//! One bounded JSON command on stdin, one JSON result on stdout. No daemon/RPC.
use std::io::Read;
fn main() {
    let mut input = Vec::new();
    let result = std::io::stdin().take(128 * 1024 + 1).read_to_end(&mut input)
        .map_err(|e| serde_json::json!({"code":"invalid_request","message":e.to_string()}))
        .and_then(|_| {
            if input.len() > 128 * 1024 {
                return Err(serde_json::json!({"code":"invalid_request","message":"Command exceeds 128 KiB"}));
            }
            serde_json::from_slice::<vatermark::web::Command>(&input)
                .map_err(|e| serde_json::json!({"code":"invalid_request","message":e.to_string()}))
        })
        .and_then(|command| vatermark::web::run(command).map_err(|e| serde_json::to_value(e).unwrap()));
    match result {
        Ok(value) => println!("{value}"),
        Err(error) => {
            println!("{}", serde_json::json!({"ok":false,"error":error}));
            std::process::exit(1);
        }
    }
}
