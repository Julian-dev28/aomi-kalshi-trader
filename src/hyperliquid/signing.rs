use k256::ecdsa::{RecoveryId, Signature, SigningKey};
#[allow(unused_imports)]
use k256::ecdsa::signature::hazmat::PrehashSigner;
use sha3::{Digest, Keccak256};
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::HL_API;

// ── MsgPack structs (field order matters for Hyperliquid hash) ─────────────

#[derive(Serialize)]
struct LimitOrder {
    tif: String,
}

#[derive(Serialize)]
struct OrderType {
    limit: LimitOrder,
}

#[derive(Serialize)]
struct OrderItem {
    a: u32,
    b: bool,
    p: String,
    s: String,
    r: bool,
    t: OrderType,
}

#[derive(Serialize)]
struct OrderAction {
    #[serde(rename = "type")]
    action_type: String,
    orders: Vec<OrderItem>,
    grouping: String,
}

// ── Helper: keccak256 ──────────────────────────────────────────────────────

fn keccak256(data: &[u8]) -> [u8; 32] {
    let mut hasher = Keccak256::new();
    hasher.update(data);
    hasher.finalize().into()
}

// ── Strip trailing zeros from decimal strings ──────────────────────────────

pub fn strip_zeros(s: &str) -> String {
    if !s.contains('.') {
        return s.to_string();
    }
    let trimmed = s.trim_end_matches('0').trim_end_matches('.');
    if trimmed == "-0" || trimmed.is_empty() {
        "0".to_string()
    } else {
        trimmed.to_string()
    }
}

// ── EIP-712 signing ────────────────────────────────────────────────────────

pub struct Sig {
    pub r: String,
    pub s: String,
    pub v: u32,
}

fn sign_action_bytes(action_bytes: &[u8], nonce: u64, private_key_hex: &str) -> anyhow::Result<Sig> {
    // 1. Build preimage: actionBytes + nonce(8 bytes big-endian) + 0u8
    let mut preimage = Vec::with_capacity(action_bytes.len() + 9);
    preimage.extend_from_slice(action_bytes);
    preimage.extend_from_slice(&nonce.to_be_bytes());
    preimage.push(0u8); // vault flag = 0

    // 2. connectionId = keccak256(preimage)
    let connection_id = keccak256(&preimage);

    // 3. EIP-712 domain separator
    let domain_type_hash = keccak256(
        b"EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
    );
    let name_hash = keccak256(b"Exchange");
    let version_hash = keccak256(b"1");
    let mut chain_id_bytes = [0u8; 32];
    chain_id_bytes[30] = 0x05; // 1337 = 0x0539
    chain_id_bytes[31] = 0x39;
    let verifying_contract = [0u8; 32]; // zero address, left-padded

    let mut domain_data = Vec::with_capacity(5 * 32);
    domain_data.extend_from_slice(&domain_type_hash);
    domain_data.extend_from_slice(&name_hash);
    domain_data.extend_from_slice(&version_hash);
    domain_data.extend_from_slice(&chain_id_bytes);
    domain_data.extend_from_slice(&verifying_contract);
    let domain_separator = keccak256(&domain_data);

    // 4. Struct hash: Agent(string source, bytes32 connectionId)
    let agent_type_hash =
        keccak256(b"Agent(string source,bytes32 connectionId)");
    let source_hash = keccak256(b"a"); // source = "a"

    let mut struct_data = Vec::with_capacity(3 * 32);
    struct_data.extend_from_slice(&agent_type_hash);
    struct_data.extend_from_slice(&source_hash);
    struct_data.extend_from_slice(&connection_id);
    let struct_hash = keccak256(&struct_data);

    // 5. Final digest: keccak256("\x19\x01" ++ domainSeparator ++ structHash)
    let mut digest_input = Vec::with_capacity(2 + 32 + 32);
    digest_input.extend_from_slice(b"\x19\x01");
    digest_input.extend_from_slice(&domain_separator);
    digest_input.extend_from_slice(&struct_hash);
    let digest = keccak256(&digest_input);

    // 6. Sign with k256
    let key_hex = private_key_hex.trim_start_matches("0x");
    let key_bytes = hex::decode(key_hex)?;
    let signing_key = SigningKey::from_slice(&key_bytes)?;

    let (sig, recovery_id): (Signature, RecoveryId) =
        signing_key.sign_prehash_recoverable(&digest)?;

    let sig_bytes = sig.to_bytes();
    let r_bytes = &sig_bytes[..32];
    let s_bytes = &sig_bytes[32..];
    let v = recovery_id.to_byte() as u32 + 27;

    Ok(Sig {
        r: format!("0x{}", hex::encode(r_bytes)),
        s: format!("0x{}", hex::encode(s_bytes)),
        v,
    })
}

fn msgpack_encode<T: Serialize>(val: &T) -> anyhow::Result<Vec<u8>> {
    let bytes = rmp_serde::to_vec_named(val)?;
    Ok(bytes)
}

fn exchange_body(
    action: &serde_json::Value,
    nonce: u64,
    sig: &Sig,
) -> serde_json::Value {
    json!({
        "action": action,
        "nonce": nonce,
        "signature": {
            "r": sig.r,
            "s": sig.s,
            "v": sig.v,
        }
    })
}

// ── Public: place order ────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct OrderResult {
    pub ok: bool,
    pub order_id: Option<String>,
    pub error: Option<String>,
}

pub async fn place_hl_order(
    client: &reqwest::Client,
    private_key: &str,
    is_buy: bool,
    size_btc: f64,
    mid_price: f64,
) -> anyhow::Result<OrderResult> {
    if private_key.is_empty() {
        return Ok(OrderResult {
            ok: false,
            order_id: None,
            error: Some("HYPERLIQUID_PRIVATE_KEY not set".to_string()),
        });
    }

    let limit_px = if is_buy {
        (mid_price * 1.05).round().to_string()
    } else {
        (mid_price * 0.95).round().to_string()
    };

    let size_str = strip_zeros(&format!("{:.5}", size_btc));

    let action = OrderAction {
        action_type: "order".to_string(),
        orders: vec![OrderItem {
            a: 0,
            b: is_buy,
            p: limit_px.clone(),
            s: size_str.clone(),
            r: false,
            t: OrderType {
                limit: LimitOrder {
                    tif: "Ioc".to_string(),
                },
            },
        }],
        grouping: "na".to_string(),
    };

    let action_bytes = msgpack_encode(&action)?;
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_millis() as u64;

    let sig = sign_action_bytes(&action_bytes, nonce, private_key)?;

    let action_json = json!({
        "type": "order",
        "orders": [{
            "a": 0,
            "b": is_buy,
            "p": limit_px,
            "s": size_str,
            "r": false,
            "t": { "limit": { "tif": "Ioc" } }
        }],
        "grouping": "na"
    });

    let body = exchange_body(&action_json, nonce, &sig);

    let res = client
        .post(format!("{}/exchange", HL_API))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await?;

    let result: serde_json::Value = res.json().await?;

    if result["status"].as_str() == Some("ok") {
        let st = &result["response"]["data"]["statuses"][0];
        if !st["filled"].is_null() {
            let oid = st["filled"]["oid"].to_string();
            return Ok(OrderResult {
                ok: true,
                order_id: Some(oid),
                error: None,
            });
        }
        if let Some(err) = st["error"].as_str() {
            return Ok(OrderResult {
                ok: false,
                order_id: None,
                error: Some(err.to_string()),
            });
        }
        return Ok(OrderResult {
            ok: true,
            order_id: None,
            error: None,
        });
    }

    Ok(OrderResult {
        ok: false,
        order_id: None,
        error: Some(result.to_string()),
    })
}

// ── Set leverage ───────────────────────────────────────────────────────────

#[derive(Serialize)]
struct LeverageAction {
    #[serde(rename = "type")]
    action_type: String,
    asset: u32,
    #[serde(rename = "isCross")]
    is_cross: bool,
    leverage: u32,
}

pub async fn set_leverage(
    client: &reqwest::Client,
    private_key: &str,
    leverage: u32,
) -> anyhow::Result<()> {
    if private_key.is_empty() {
        return Ok(());
    }

    let action = LeverageAction {
        action_type: "updateLeverage".to_string(),
        asset: 0,
        is_cross: true,
        leverage,
    };

    let action_bytes = msgpack_encode(&action)?;
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_millis() as u64;

    let sig = sign_action_bytes(&action_bytes, nonce, private_key)?;

    let action_json = json!({
        "type": "updateLeverage",
        "asset": 0,
        "isCross": true,
        "leverage": leverage
    });

    let body = exchange_body(&action_json, nonce, &sig);

    client
        .post(format!("{}/exchange", HL_API))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await?;

    Ok(())
}

// ── Transfer spot to perp ──────────────────────────────────────────────────

#[derive(Serialize)]
struct TransferAction {
    #[serde(rename = "type")]
    action_type: String,
    amount: String,
    #[serde(rename = "toPerp")]
    to_perp: bool,
}

pub async fn transfer_spot_to_perp(
    client: &reqwest::Client,
    private_key: &str,
    amount: f64,
) -> anyhow::Result<()> {
    if private_key.is_empty() || amount <= 0.0 {
        return Ok(());
    }

    let action = TransferAction {
        action_type: "usdClassTransfer".to_string(),
        amount: format!("{:.2}", amount),
        to_perp: true,
    };

    let action_bytes = msgpack_encode(&action)?;
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_millis() as u64;

    let sig = sign_action_bytes(&action_bytes, nonce, private_key)?;

    let action_json = json!({
        "type": "usdClassTransfer",
        "amount": format!("{:.2}", amount),
        "toPerp": true
    });

    let body = exchange_body(&action_json, nonce, &sig);

    client
        .post(format!("{}/exchange", HL_API))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await?;

    Ok(())
}
