use std::collections::HashMap;
use std::convert::Infallible;

use axum::extract::State;
use axum::response::sse::{Event, Sse};
use axum::Json;
use futures::stream::Stream;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tokio_util::sync::CancellationToken;

use crate::aomi::session::{build_system_message, get_tools};
use crate::aomi::tools::execute_tool;
use crate::state::AppState;

#[derive(Deserialize)]
pub struct ChatRequest {
    pub message: String,
    pub hint: Option<String>,
    #[serde(rename = "sessionId")]
    pub session_id: Option<String>,
    #[allow(dead_code)]
    pub market_data: Option<Value>,
    #[allow(dead_code)]
    #[serde(rename = "riskPct")]
    pub risk_pct: Option<f64>,
}

pub async fn chat_handler(
    State(state): State<AppState>,
    Json(body): Json<ChatRequest>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let (tx, rx) = mpsc::channel::<Result<Event, Infallible>>(64);

    let session_id = body.session_id.clone().unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let cancel_token = CancellationToken::new();
    state.cancel_tokens.insert(session_id.clone(), cancel_token.clone());

    let config = state.config.clone();
    let http_client = state.http.clone();

    tokio::spawn(async move {
        let send = |data: Value| {
            let ev = Event::default().data(data.to_string());
            let _ = tx.try_send(Ok(ev));
        };

        send(json!({ "type": "processing_start" }));

        let system_content = build_system_message(body.hint.as_deref());
        let tools = get_tools(config.brave_api_key.is_some());

        let mut messages: Vec<Value> = vec![
            json!({ "role": "system", "content": system_content }),
            json!({ "role": "user", "content": body.message }),
        ];
        let mut loops = 0;

        'outer: loop {
            if loops >= 10 {
                break;
            }
            loops += 1;

            if cancel_token.is_cancelled() {
                break;
            }

            let payload = json!({
                "model": config.openrouter_model,
                "messages": messages,
                "tools": tools,
                "tool_choice": "auto",
                "stream": true
            });

            let resp = match tokio::time::timeout(
                std::time::Duration::from_secs(90),
                http_client
                    .post("https://openrouter.ai/api/v1/chat/completions")
                    .header("Authorization", format!("Bearer {}", config.openrouter_api_key))
                    .header("Content-Type", "application/json")
                    .header("HTTP-Referer", "https://aomi-trader.app")
                    .header("X-Title", "AOMI Trader")
                    .json(&payload)
                    .send(),
            )
            .await
            {
                Ok(Ok(r)) => r,
                Ok(Err(e)) => {
                    send(json!({ "type": "error", "text": e.to_string() }));
                    break;
                }
                Err(_) => {
                    send(json!({ "type": "error", "text": "OpenRouter request timed out" }));
                    break;
                }
            };

            if !resp.status().is_success() {
                let status = resp.status().as_u16();
                let text = resp.text().await.unwrap_or_default();
                send(json!({
                    "type": "error",
                    "text": format!("OpenRouter error {}: {}", status, text)
                }));
                break;
            }

            // Parse OpenRouter SSE stream
            use futures::StreamExt;
            let mut stream = resp.bytes_stream();
            let mut buf = String::new();
            let mut assistant_text = String::new();
            // tool_accum: index -> {id, name, arguments}
            let mut tool_accum: HashMap<u64, (String, String, String)> = HashMap::new();
            let mut finish_reason: Option<String> = None;

            'stream: loop {
                if cancel_token.is_cancelled() {
                    break 'outer;
                }

                let chunk = tokio::select! {
                    c = stream.next() => c,
                    _ = cancel_token.cancelled() => break 'outer,
                };

                let chunk = match chunk {
                    Some(Ok(c)) => c,
                    Some(Err(e)) => {
                        send(json!({ "type": "error", "text": e.to_string() }));
                        break 'outer;
                    }
                    None => break 'stream,
                };

                buf.push_str(&String::from_utf8_lossy(&chunk));

                // Process complete lines
                while let Some(pos) = buf.find('\n') {
                    let line = buf[..pos].trim().to_string();
                    buf.drain(..=pos);

                    if line.is_empty() || line.starts_with(':') {
                        continue;
                    }
                    if !line.starts_with("data: ") {
                        continue;
                    }
                    let data = &line[6..];
                    if data == "[DONE]" {
                        break 'stream;
                    }

                    let chunk_json: Value = match serde_json::from_str(data) {
                        Ok(v) => v,
                        Err(_) => continue,
                    };

                    let choice = &chunk_json["choices"][0];
                    if !choice.is_null() {
                        if let Some(fr) = choice["finish_reason"].as_str() {
                            if fr != "null" {
                                finish_reason = Some(fr.to_string());
                            }
                        }

                        let delta = &choice["delta"];

                        if let Some(content) = delta["content"].as_str() {
                            if !content.is_empty() {
                                assistant_text.push_str(content);
                                send(json!({ "type": "message", "text": assistant_text }));
                            }
                        }

                        if let Some(tool_calls) = delta["tool_calls"].as_array() {
                            for tc in tool_calls {
                                let idx = tc["index"].as_u64().unwrap_or(0);
                                let entry = tool_accum.entry(idx).or_insert_with(|| (String::new(), String::new(), String::new()));
                                if let Some(id) = tc["id"].as_str() { entry.0.push_str(id); }
                                if let Some(name) = tc["function"]["name"].as_str() { entry.1.push_str(name); }
                                if let Some(args) = tc["function"]["arguments"].as_str() { entry.2.push_str(args); }
                            }
                        }
                    }
                }
            }

            // Check if we need to execute tools
            let tool_calls: Vec<(String, String, String)> = {
                let mut sorted: Vec<(u64, (String, String, String))> = tool_accum.into_iter().collect();
                sorted.sort_by_key(|(k, _)| *k);
                sorted.into_iter().map(|(_, v)| v).collect()
            };

            let is_tool_call = !tool_calls.is_empty()
                && finish_reason.as_deref() == Some("tool_calls");

            if is_tool_call {
                // Append assistant message with tool_calls
                let tool_calls_json: Vec<Value> = tool_calls
                    .iter()
                    .map(|(id, name, arguments)| {
                        json!({
                            "id": id,
                            "type": "function",
                            "function": { "name": name, "arguments": arguments }
                        })
                    })
                    .collect();

                let assistant_msg = if assistant_text.is_empty() {
                    json!({
                        "role": "assistant",
                        "content": null,
                        "tool_calls": tool_calls_json
                    })
                } else {
                    json!({
                        "role": "assistant",
                        "content": assistant_text,
                        "tool_calls": tool_calls_json
                    })
                };
                messages.push(assistant_msg);

                // Execute each tool
                for (tc_id, tc_name, tc_args_str) in &tool_calls {
                    if cancel_token.is_cancelled() {
                        break 'outer;
                    }

                    send(json!({ "type": "tool", "name": tc_name, "status": "running" }));

                    let args: HashMap<String, Value> = serde_json::from_str(tc_args_str)
                        .unwrap_or_default();

                    let result = execute_tool(
                        &http_client,
                        tc_name,
                        &args,
                        &config.hl_account,
                        config.brave_api_key.as_deref(),
                    )
                    .await;

                    send(json!({ "type": "tool", "name": tc_name, "status": "done" }));

                    messages.push(json!({
                        "role": "tool",
                        "tool_call_id": tc_id,
                        "content": result
                    }));
                }

                // Loop back with tool results
                continue;
            }

            // Final text response
            if !assistant_text.is_empty() {
                send(json!({ "type": "message", "text": assistant_text }));
            } else {
                send(json!({ "type": "message", "text": "No response from agent." }));
            }
            break;
        }

        send(json!({ "type": "processing_end" }));
        send(json!({ "type": "done" }));

        state.cancel_tokens.remove(&session_id);
    });

    Sse::new(ReceiverStream::new(rx))
        .keep_alive(axum::response::sse::KeepAlive::default())
}
