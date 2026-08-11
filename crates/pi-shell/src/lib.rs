pub mod cancel;
mod cmp;
mod coreutils;
mod fd;
pub mod minimizer;
mod moreutils;
pub mod parsing;
pub mod process;
pub mod shell;
mod which;
#[cfg(windows)]
pub mod windows;

pub use brush_core::commands::{ChildSessionAction, child_session_action};
pub use parsing::{parse_script, parse_script_json};
pub use shell::{
	MinimizerResult, Shell, ShellExecuteOptions, ShellExecuteResult, ShellOptions, ShellRunOptions,
	ShellRunResult, StreamSinks, execute_shell, execute_shell_streams,
};
