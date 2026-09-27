//! Asking for an HTTP login on the terminal when a private remote wants one.

use std::io::{BufRead, IsTerminal, Write};
use std::sync::Mutex;

use anyhow::bail;
use strata_store::pipeline::{AuthRequired, Credentials};

/// Terminal settings to put back if the process exits while echo is off.
static SAVED: Mutex<Option<libc::termios>> = Mutex::new(None);

/// Both ends are a terminal, so there is someone to ask.
pub fn interactive() -> bool {
    std::io::stdin().is_terminal() && std::io::stderr().is_terminal()
}

pub fn ask(auth: &AuthRequired) -> anyhow::Result<Credentials> {
    let mut err = std::io::stderr();
    if auth.rejected {
        writeln!(err, "{} rejected that login.", auth.host)?;
    } else {
        writeln!(err, "{} wants a login (kept in memory only).", auth.host)?;
    }
    write!(err, "Username: ")?;
    err.flush()?;
    let username = read_line()?;
    write!(err, "Password or access token: ")?;
    err.flush()?;
    let password = {
        let _quiet = EchoOff::new();
        read_line()?
    };
    writeln!(err)?;
    Credentials::new(username.trim(), &password)
}

fn read_line() -> anyhow::Result<String> {
    let mut s = String::new();
    if std::io::stdin().lock().read_line(&mut s)? == 0 {
        bail!("no login entered");
    }
    Ok(s.trim_end_matches(['\n', '\r']).to_string())
}

/// Turns terminal echo off until dropped.
struct EchoOff;

impl EchoOff {
    fn new() -> Self {
        // SAFETY: termios calls on stdin, which `interactive()` checked is a terminal.
        unsafe {
            let mut t: libc::termios = std::mem::zeroed();
            if libc::tcgetattr(libc::STDIN_FILENO, &mut t) == 0 {
                *SAVED.lock().unwrap() = Some(t);
                let mut quiet = t;
                quiet.c_lflag &= !libc::ECHO;
                libc::tcsetattr(libc::STDIN_FILENO, libc::TCSANOW, &quiet);
            }
        }
        EchoOff
    }
}

impl Drop for EchoOff {
    fn drop(&mut self) {
        restore_terminal();
    }
}

/// Turns echo back on if a password prompt left it off (also called before exiting on Ctrl-C).
pub fn restore_terminal() {
    if let Some(t) = SAVED.lock().unwrap().take() {
        // SAFETY: restores settings read from the same descriptor.
        unsafe { libc::tcsetattr(libc::STDIN_FILENO, libc::TCSANOW, &t) };
    }
}
