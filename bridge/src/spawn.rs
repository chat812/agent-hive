use anyhow::{Context, Result};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};

pub struct AgentProcess {
    pub id: String,
    pub pid: u32,
    pub cmd: String,
    pty: Box<dyn MasterPty + Send>,
    pty_reader: Option<Box<dyn Read + Send>>,
    pty_writer: Option<Box<dyn Write + Send>>,
}

impl AgentProcess {
    pub fn spawn(cmd: String, args: Vec<String>) -> Result<Self> {
        let id = hex::encode(&uuid::Uuid::new_v4().as_bytes()[..4]);

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 30,
                cols: 120,
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("Failed to create PTY")?;

        // On Windows, wrap in cmd.exe /C to resolve .cmd/.sh launchers
        #[cfg(target_os = "windows")]
        let builder = {
            let mut all_args = vec![cmd.clone()];
            all_args.extend(args.iter().cloned());
            let mut b = CommandBuilder::new("cmd.exe");
            b.arg("/C");
            b.args(&all_args);
            b
        };

        #[cfg(not(target_os = "windows"))]
        let builder = {
            let mut b = CommandBuilder::new(&cmd);
            b.args(&args);
            b
        };

        let child = pair
            .slave
            .spawn_command(builder)
            .context("Failed to spawn child process")?;

        let pid = child.process_id().unwrap_or(0);

        let reader = pair.master.try_clone_reader().context("Failed to clone PTY reader")?;
        let writer = pair.master.take_writer().context("Failed to get PTY writer")?;

        Ok(Self {
            id,
            pid,
            cmd,
            pty: pair.master,
            pty_reader: Some(Box::new(reader)),
            pty_writer: Some(writer),
        })
    }

    pub fn write(&mut self, data: &[u8]) -> Result<()> {
        if let Some(ref mut writer) = self.pty_writer {
            writer.write_all(data)?;
            writer.flush()?;
        }
        Ok(())
    }

    pub fn resize(&mut self, cols: u16, rows: u16) -> Result<()> {
        self.pty.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        Ok(())
    }

    pub fn kill(&mut self) -> Result<()> {
        if let Some(ref mut writer) = self.pty_writer {
            let _ = writer.write_all(b"\x03");
            let _ = writer.flush();
        }
        Ok(())
    }

    pub fn take_reader(&mut self) -> Option<Box<dyn Read + Send>> {
        self.pty_reader.take()
    }
}
