use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::response::Response;
use serde::Deserialize;
use tokio::sync::broadcast;

use crate::state::{AppState, RepoEvent};

#[derive(Deserialize)]
pub struct WsQuery {
    pub path: String,
}

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    State(app): State<Arc<AppState>>,
    Query(q): Query<WsQuery>,
) -> Response {
    let st = match app.repo_state(&q.path) {
        Ok(st) => st,
        Err(e) => {
            return Response::builder()
                .status(400)
                .body(axum::body::Body::from(format!("bad repo path: {}", e)))
                .unwrap();
        }
    };
    ws.on_upgrade(move |socket| ws_loop(socket, st))
}

async fn ws_loop(mut socket: WebSocket, st: Arc<crate::state::RepoState>) {
    let mut rx: broadcast::Receiver<RepoEvent> = st.events.subscribe();

    // hello with the current revision
    let hello = serde_json::json!({
        "type": "hello",
        "revision": st.current_revision(),
    });
    if socket.send(Message::Text(hello.to_string().into())).await.is_err() {
        return;
    }

    loop {
        tokio::select! {
            ev = rx.recv() => {
                match ev {
                    Ok(ev) => {
                        let text = serde_json::to_string(&ev).unwrap_or_default();
                        if socket.send(Message::Text(text.into())).await.is_err() {
                            return;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        // client missed events — tell it to resync from its revision
                        let text = serde_json::json!({
                            "type": "changed",
                            "revision": st.current_revision(),
                            "kinds": ["refs", "index", "worktree"],
                        })
                        .to_string();
                        if socket.send(Message::Text(text.into())).await.is_err() {
                            return;
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => return,
                }
            }
            msg = socket.recv() => {
                match msg {
                    None | Some(Err(_)) => return,
                    Some(Ok(Message::Close(_))) => return,
                    Some(Ok(_)) => continue, // ignore client pings/messages
                }
            }
        }
    }
}
