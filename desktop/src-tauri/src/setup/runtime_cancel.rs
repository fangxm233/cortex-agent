use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

static ACTIVE: Mutex<Option<Arc<AtomicBool>>> = Mutex::new(None);

#[derive(Clone, Default)]
pub struct CancelToken(Arc<AtomicBool>);

impl CancelToken {
    pub fn check(&self) -> Result<(), String> {
        if self.0.load(Ordering::SeqCst) {
            Err("SETUP_CANCELLED".into())
        } else {
            Ok(())
        }
    }
}

pub struct InstallGuard(CancelToken);

impl InstallGuard {
    pub fn begin() -> Result<Self, String> {
        let mut active = ACTIVE
            .lock()
            .map_err(|_| "SERVER_INSTALL_FAILED: installer lock")?;
        if active.is_some() {
            return Err("SERVER_INSTALL_FAILED: installation already running".into());
        }
        let token = CancelToken::default();
        *active = Some(token.0.clone());
        Ok(Self(token))
    }

    pub fn token(&self) -> &CancelToken {
        &self.0
    }
}

impl Drop for InstallGuard {
    fn drop(&mut self) {
        if let Ok(mut active) = ACTIVE.lock() {
            *active = None;
        }
    }
}

pub fn cancel_install() {
    if let Ok(active) = ACTIVE.lock() {
        if let Some(token) = active.as_ref() {
            token.store(true, Ordering::SeqCst);
        }
    }
}
