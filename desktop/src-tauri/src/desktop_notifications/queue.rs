use crate::ConnectionConfig;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

pub const CAPACITY: usize = 64;

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutingData {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Action {
    pub action_id: String,
    pub server_url: String,
    #[serde(flatten)]
    pub data: RoutingData,
}

#[derive(Default, Serialize)]
pub struct Pending {
    pub actions: Vec<Action>,
}

// Deliberately neither Serialize nor Debug: credentials never cross the bridge.
struct Entry {
    action: Action,
    token: Option<String>,
}

#[derive(Default)]
pub struct Queue {
    sequence: u64,
    posted: VecDeque<Entry>,
    pending: VecDeque<Entry>,
}

impl Queue {
    pub fn post(&mut self, config: &ConnectionConfig, data: RoutingData) -> Result<String, String> {
        let server_url = config
            .server_url
            .clone()
            .filter(|url| !url.is_empty())
            .ok_or("No native connection configured")?;
        self.sequence += 1;
        let action_id = self.sequence.to_string();
        let action = Action {
            action_id: action_id.clone(),
            server_url,
            data,
        };
        push_bounded(
            &mut self.posted,
            Entry {
                action,
                token: config.token.clone(),
            },
        );
        Ok(action_id)
    }

    pub fn activate(&mut self, id: &str, config: &ConnectionConfig) -> bool {
        let Some(index) = self
            .posted
            .iter()
            .position(|entry| entry.action.action_id == id)
        else {
            return false;
        };
        let entry = self.posted.remove(index).unwrap();
        if !entry.matches(config) {
            return false;
        }
        push_bounded(&mut self.pending, entry);
        true
    }

    pub fn pending(&mut self, config: &ConnectionConfig) -> Pending {
        self.pending.retain(|entry| entry.matches(config));
        Pending {
            actions: self
                .pending
                .iter()
                .map(|entry| entry.action.clone())
                .collect(),
        }
    }

    pub fn ack(&mut self, id: &str) {
        self.pending.retain(|entry| entry.action.action_id != id);
    }

    pub fn forget(&mut self, id: &str) {
        self.posted.retain(|entry| entry.action.action_id != id);
    }
}

impl Entry {
    fn matches(&self, config: &ConnectionConfig) -> bool {
        config.server_url.as_deref() == Some(self.action.server_url.as_str())
            && config.token == self.token
    }
}

fn push_bounded(queue: &mut VecDeque<Entry>, entry: Entry) {
    if queue.len() == CAPACITY {
        queue.pop_front();
    }
    queue.push_back(entry);
}

#[cfg(any(target_os = "windows", test))]
pub fn is_default_action(action: Option<&str>) -> bool {
    matches!(action, None | Some("" | "default"))
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
pub fn is_default_response(response: &notify_rust::NotificationResponse) -> bool {
    use notify_rust::NotificationResponse;
    matches!(response, NotificationResponse::Default)
        || matches!(response, NotificationResponse::Action(action) if action == "default")
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
