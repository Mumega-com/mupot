use eframe::egui::{self, Color32, RichText};
use mumachine::*;
use std::sync::{Arc, mpsc};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const ACCENT: Color32 = Color32::from_rgb(89, 214, 173);
const INK: Color32 = Color32::from_rgb(16, 24, 32);
const SURFACE: Color32 = Color32::from_rgb(23, 35, 45);
const MUTED: Color32 = Color32::from_rgb(173, 190, 201);

#[derive(Clone, Copy, PartialEq, Eq)]
enum Page {
    Network,
    Connect,
    Boot,
    Activity,
}

/// UI operations are invalidated before forgetting, cancellation or input changes.
/// Workers never persist a redeemed credential: acceptance and saving are serialized
/// on the UI thread, after this fence and DeviceFlow both accept the result.
#[derive(Default)]
struct OperationFence(u64);
impl OperationFence {
    fn advance(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(1);
        self.0
    }
    fn accepts(&self, generation: u64) -> bool {
        self.0 == generation
    }
}

enum Event {
    Challenge(OperationId, Result<DeviceChallenge>),
    Poll(OperationId, Result<DevicePoll>),
    Restored(Result<VerifiedConnection>),
    Refreshed(Result<BootSnapshot>),
    CheckedIn(Result<CheckInReceipt>),
    Health(Result<Health>),
}
struct WorkerResult {
    generation: u64,
    event: Event,
}

pub struct ConnectApp {
    mark: Option<egui::TextureHandle>,
    demo: bool,
    page: Page,
    dark: bool,
    origin: String,
    tenant: String,
    desired: String,
    search: String,
    flow: DeviceFlow,
    fence: OperationFence,
    pending: bool,
    client: Option<MupotClient>,
    connection: Option<Arc<VerifiedConnection>>,
    snapshot: Option<BootSnapshot>,
    storage: String,
    profiles: Vec<Profile>,
    repository: Option<ProfileRepository>,
    error: Option<String>,
    note: String,
    activity: Vec<String>,
    confirm_forget: bool,
    tx: mpsc::Sender<WorkerResult>,
    rx: mpsc::Receiver<WorkerResult>,
    discovery_tx: mpsc::Sender<DiscoverySnapshot>,
    discovery_rx: mpsc::Receiver<DiscoverySnapshot>,
    discovery: Option<DiscoverySnapshot>,
    discovering: bool,
}

impl ConnectApp {
    pub fn new(cc: &eframe::CreationContext<'_>, demo: bool, page: &str, light: bool) -> Self {
        Self::with_context(&cc.egui_ctx, demo, page, light)
    }

    fn with_context(ctx: &egui::Context, demo: bool, page: &str, light: bool) -> Self {
        let (tx, rx) = mpsc::channel();
        let (discovery_tx, discovery_rx) = mpsc::channel();
        let repository = if demo {
            None
        } else {
            default_directory().and_then(ProfileRepository::open).ok()
        };
        let (profiles, storage_unavailable) = match repository.as_ref() {
            Some(repo) => match repo.list() {
                Ok(profiles) => (profiles, false),
                Err(_) => (Vec::new(), true),
            },
            None => (Vec::new(), !demo),
        };
        let mark = eframe::icon_data::from_png_bytes(include_bytes!(
            "../../../src/dashboard/brand/mupot-mark-64.png"
        ))
        .ok()
        .map(|icon| {
            ctx.load_texture(
                "Mupot brand mark",
                egui::ColorImage::from_rgba_unmultiplied(
                    [icon.width as usize, icon.height as usize],
                    &icon.rgba,
                ),
                egui::TextureOptions::LINEAR,
            )
        });
        let mut app = Self {
            mark,
            demo,
            page: match page {
                "connect" => Page::Connect,
                "boot" => Page::Boot,
                "activity" => Page::Activity,
                _ => Page::Network,
            },
            dark: !light,
            origin: if demo {
                "https://example.invalid".into()
            } else {
                String::new()
            },
            tenant: String::new(),
            desired: String::new(),
            search: String::new(),
            flow: DeviceFlow::default(),
            fence: OperationFence::default(),
            pending: false,
            client: None,
            connection: None,
            snapshot: None,
            storage: String::new(),
            profiles,
            repository,
            error: storage_unavailable.then(|| "This app could not read its saved profiles. Local discovery is available, but saved connections are unavailable until local storage can be accessed.".into()),
            note: "No Mupot connection. Local discovery needs no credential.".into(),
            activity: vec![if demo {
                "Demo started. Sample data only; network, discovery and Keychain are disabled."
                    .into()
            } else {
                "App opened. No credential loaded; no runtime started.".into()
            }],
            confirm_forget: false,
            tx,
            rx,
            discovery_tx,
            discovery_rx,
            discovery: None,
            discovering: false,
        };
        app.set_theme(ctx);
        if !demo {
            app.refresh_discovery(ctx);
        }
        app
    }

    fn set_theme(&self, ctx: &egui::Context) {
        let mut style = egui::Style {
            visuals: if self.dark {
                egui::Visuals::dark()
            } else {
                egui::Visuals::light()
            },
            ..Default::default()
        };
        if self.dark {
            style.visuals.panel_fill = INK;
            style.visuals.window_fill = SURFACE;
            style.visuals.override_text_color = Some(Color32::from_rgb(237, 243, 246));
            style.visuals.widgets.noninteractive.bg_fill = SURFACE;
        }
        style.visuals.selection.bg_fill = Color32::from_rgb(32, 92, 76);
        style.visuals.selection.stroke.color = Color32::WHITE;
        style.visuals.text_edit_bg_color = Some(if self.dark {
            INK
        } else {
            Color32::from_rgb(237, 242, 246)
        });
        style.visuals.widgets.inactive.bg_stroke = egui::Stroke::new(
            1.0,
            if self.dark {
                Color32::from_rgb(81, 104, 121)
            } else {
                Color32::from_rgb(164, 183, 196)
            },
        );
        style.spacing.item_spacing = egui::vec2(12.0, 12.0);
        style.spacing.button_padding = egui::vec2(16.0, 12.0);
        style.spacing.interact_size.y = 44.0;
        style
            .text_styles
            .insert(egui::TextStyle::Body, egui::FontId::proportional(16.0));
        style
            .text_styles
            .insert(egui::TextStyle::Button, egui::FontId::proportional(15.0));
        style
            .text_styles
            .insert(egui::TextStyle::Small, egui::FontId::proportional(13.0));
        style
            .text_styles
            .insert(egui::TextStyle::Heading, egui::FontId::proportional(28.0));
        ctx.set_global_style(style);
    }

    fn log(&mut self, message: impl Into<String>) {
        let message = message.into();
        self.note = message.clone();
        self.activity.insert(0, message);
        self.activity.truncate(40);
    }

    fn spawn(&self, ctx: &egui::Context, task: impl FnOnce() -> Event + Send + 'static) {
        if self.demo {
            return;
        }
        let tx = self.tx.clone();
        let ctx = ctx.clone();
        let generation = self.fence.0;
        std::thread::spawn(move || {
            let _ = tx.send(WorkerResult {
                generation,
                event: task(),
            });
            ctx.request_repaint();
        });
    }

    fn refresh_discovery(&mut self, ctx: &egui::Context) {
        if self.demo || self.discovering {
            return;
        }
        self.discovering = true;
        let tx = self.discovery_tx.clone();
        let ctx = ctx.clone();
        std::thread::spawn(move || {
            let _ = tx.send(discover_local());
            ctx.request_repaint();
        });
    }

    fn invalidate(&mut self) {
        self.fence.advance();
        self.flow.cancel();
        self.pending = false;
        self.error = None;
    }

    fn report_error(&mut self, error: Error) {
        let message = match error {
            Error::InvalidOrigin => "Enter your Mupot address starting with https://, such as https://your-pot.example, without a page path or extra URL parameters.",
            Error::InvalidInput => "Enter your organization ID and an existing agent name or ID.",
            Error::IdentityMismatch => "The returned identity or tenant did not match. Nothing was saved. Check the agent and tenant, then reconnect.",
            Error::Expired => "This approval or credential has expired. Start a new connection when ready.",
            Error::Refused => "Mupot refused this request. Check your browser approval and agent access before trying again.",
            Error::Storage => "The app could not access its local profile or Keychain item. The connection was not saved successfully.",
            Error::Unsupported => "Secure credential storage is unavailable on this platform. Credentials cannot be saved here.",
            Error::Transport => "Mupot could not be reached securely. Check the origin and your connection, then try again.",
            Error::ResponseTooLarge | Error::InvalidResponse => "Mupot returned an unsupported response. No new credential was saved. Check the server and retry explicitly.",
            Error::StaleOperation => "The old operation was discarded. Start again when ready.",
        }.to_string();
        self.error = Some(message.clone());
        self.log(message);
    }

    fn failed_reproof(&mut self, error: Error) {
        // A failed fresh identity proof must not leave an old verified badge or
        // enabled app-presence action on screen. Saved metadata remains available
        // for an explicit reconnect or forget.
        self.connection = None;
        self.snapshot = None;
        self.storage.clear();
        self.report_error(error);
    }

    fn start_connection(&mut self, ctx: &egui::Context) {
        if self.demo || self.pending {
            return;
        }
        self.invalidate();
        if self.tenant.trim().is_empty() || self.desired.trim().is_empty() {
            self.report_error(Error::InvalidInput);
            return;
        }
        let client = match PotOrigin::parse(self.origin.trim()).and_then(MupotClient::new) {
            Ok(client) => client,
            Err(error) => {
                self.report_error(error);
                return;
            }
        };
        self.origin = client.origin().as_str().into();
        self.tenant = self.tenant.trim().into();
        self.desired = self.desired.trim().into();
        let op = self.flow.begin();
        self.client = Some(client.clone());
        self.pending = true;
        self.log("Requesting a browser approval code…");
        let desired = self.desired.clone();
        self.spawn(ctx, move || {
            Event::Challenge(op, client.start_device(&desired))
        });
    }

    fn accept_connection(&mut self, connection: VerifiedConnection, save: bool) {
        if connection.is_expired() {
            self.report_error(Error::Expired);
            return;
        }
        // The UI is the single writer. No event or cancel can interleave between the
        // generation check in receive() and this app-scoped save.
        self.storage = if save {
            match self
                .repository
                .as_ref()
                .ok_or(Error::Storage)
                .and_then(|repo| repo.save(&connection, &KeychainVault))
            {
                Ok(profile) => {
                    self.profiles.retain(|p| {
                        !(p.origin == profile.origin && p.agent_id == profile.agent_id)
                    });
                    self.profiles.push(profile);
                    "Saved in this app’s macOS Keychain item.".into()
                }
                Err(error) => {
                    self.report_error(error);
                    "Not saved. This verified connection lasts only in this app session.".into()
                }
            }
        } else {
            "Loaded from this app’s Keychain item and verified again.".into()
        };
        self.snapshot = Some(connection.snapshot.clone());
        self.connection = Some(Arc::new(connection));
        self.pending = false;
        self.log("Bound identity verified. Boot context loaded; runtime receive is not enabled.");
    }

    fn receive(&mut self, ctx: &egui::Context) {
        while let Ok(discovery) = self.discovery_rx.try_recv() {
            self.discovery = Some(discovery);
            self.discovering = false;
        }
        while let Ok(result) = self.rx.try_recv() {
            if !self.fence.accepts(result.generation) {
                continue;
            }
            match result.event {
                Event::Challenge(op, result) => match result
                    .and_then(|challenge| self.flow.accept_challenge(op, challenge, Instant::now()))
                {
                    Ok(()) => self.log(
                        "Approval code ready. Open Mupot in your browser to approve this app.",
                    ),
                    Err(error) => {
                        let _ = self.flow.fail(op);
                        self.pending = false;
                        self.report_error(error);
                    }
                },
                Event::Poll(op, result) => match result
                    .and_then(|poll| self.flow.complete_poll(op, poll, Instant::now()))
                {
                    Ok(Some(connection)) => {
                        self.pending = false;
                        self.accept_connection(connection, true);
                    }
                    Ok(None) => {}
                    Err(error) => {
                        let _ = self.flow.fail(op);
                        self.pending = false;
                        self.report_error(error);
                    }
                },
                Event::Restored(result) => {
                    self.pending = false;
                    match result {
                        Ok(connection) => self.accept_connection(connection, false),
                        Err(error) => self.report_error(error),
                    }
                }
                Event::Refreshed(result) => {
                    self.pending = false;
                    match result {
                        Ok(snapshot) => {
                            self.snapshot = Some(snapshot);
                            self.log("Boot context refreshed and identity reverified.");
                        }
                        Err(error) => self.failed_reproof(error),
                    }
                }
                Event::CheckedIn(result) => {
                    self.pending = false;
                    match result { Ok(_) => self.log("This app checked in after identity verification. No AI runtime was launched; receive remains disabled."), Err(error) => self.failed_reproof(error) }
                }
                Event::Health(result) => {
                    self.pending = false;
                    match result { Ok(health) => self.log(format!("Server {} · organization {} · version {}. This does not verify an agent.", if health.ok { "reachable" } else { "unhealthy" }, health.tenant, health.version)), Err(error) => self.report_error(error) }
                }
            }
        }
        if self.pending && self.flow.challenge().is_some() {
            match self.flow.poll_request(Instant::now()) {
                Ok(Some(request)) => {
                    if let Some(client) = self.client.clone() {
                        let desired = self.desired.clone();
                        let tenant = self.tenant.clone();
                        self.spawn(ctx, move || {
                            Event::Poll(
                                request.operation,
                                client.poll_device(&request.code, &desired, &tenant),
                            )
                        });
                    }
                }
                Err(error) => {
                    self.invalidate();
                    self.report_error(error);
                }
                _ => {}
            }
            ctx.request_repaint_after(Duration::from_millis(250));
        }
        if self
            .connection
            .as_ref()
            .is_some_and(|connection| connection.is_expired())
        {
            self.invalidate();
            self.connection = None;
            self.snapshot = None;
            self.storage.clear();
            self.report_error(Error::Expired);
        }
        if self.connection.is_some() {
            ctx.request_repaint_after(Duration::from_secs(1));
        }
    }

    fn load_profile(&mut self, ctx: &egui::Context, profile: Profile) {
        if self.demo || self.pending {
            return;
        }
        self.invalidate();
        self.connection = None;
        self.snapshot = None;
        self.origin = profile.origin.clone();
        self.tenant = profile.tenant.clone();
        self.desired = profile.agent_slug.clone();
        let client = match PotOrigin::parse(&profile.origin).and_then(MupotClient::new) {
            Ok(client) => client,
            Err(error) => {
                self.report_error(error);
                return;
            }
        };
        self.client = Some(client.clone());
        self.pending = true;
        self.log("Loading this app’s saved credential and verifying its bound identity…");
        self.spawn(ctx, move || {
            Event::Restored(
                default_directory()
                    .and_then(ProfileRepository::open)
                    .and_then(|repo| repo.load(&profile, &KeychainVault))
                    .and_then(|token| client.restore(&profile, token)),
            )
        });
    }

    fn forget(&mut self) {
        self.invalidate();
        let origin = self.origin.clone();
        let agent_id = self
            .snapshot
            .as_ref()
            .map(|snapshot| snapshot.agent.id.clone());
        self.connection = None;
        self.snapshot = None;
        self.storage.clear();
        self.client = None;
        let targets: Vec<Profile> = self
            .profiles
            .iter()
            .filter(|profile| {
                profile.origin == origin
                    && agent_id.as_ref().is_some_and(|id| *id == profile.agent_id)
            })
            .cloned()
            .collect();
        let mut failed = false;
        for profile in targets {
            match self
                .repository
                .as_ref()
                .ok_or(Error::Storage)
                .and_then(|repo| repo.forget(&profile, &KeychainVault))
            {
                Ok(()) => self
                    .profiles
                    .retain(|p| !(p.origin == profile.origin && p.agent_id == profile.agent_id)),
                Err(error) => {
                    failed = true;
                    self.report_error(error);
                }
            }
        }
        if !failed {
            self.log("This app’s connection was forgotten. Server credentials were not revoked.");
        }
        self.confirm_forget = false;
    }

    fn sidebar(&mut self, ui: &mut egui::Ui) {
        ui.add_space(16.0);
        if let Some(mark) = &self.mark {
            ui.add(egui::Image::new((mark.id(), egui::vec2(40.0, 40.0))).alt_text("Mupot"));
        }
        ui.label(
            RichText::new("MUPOT")
                .size(24.0)
                .strong()
                .color(if self.dark {
                    ACCENT
                } else {
                    Color32::from_rgb(18, 106, 76)
                }),
        );
        ui.label(RichText::new("Connect").size(17.0));
        ui.add_space(32.0);
        for (page, label) in [
            (Page::Network, "Network"),
            (Page::Connect, "Connect"),
            (Page::Boot, "Boot context"),
            (Page::Activity, "Activity"),
        ] {
            if ui
                .add_sized(
                    [176.0, 46.0],
                    egui::Button::new(label).selected(self.page == page),
                )
                .clicked()
            {
                self.page = page;
            }
        }
        ui.add_space(32.0);
        ui.separator();
        ui.small(connection_label(self.demo, self.connection.is_some()));
        ui.small("Runtime receive: not enabled");
        ui.add_space(16.0);
        if ui
            .button(if self.dark {
                "Use light theme"
            } else {
                "Use dark theme"
            })
            .clicked()
        {
            self.dark = !self.dark;
            self.set_theme(ui.ctx());
        }
        ui.small("Text size");
        ui.horizontal(|ui| {
            if ui.button("A−").on_hover_text("Smaller text").clicked() {
                ui.ctx()
                    .set_zoom_factor((ui.ctx().zoom_factor() - 0.1).max(0.8));
            }
            if ui.button("A+").on_hover_text("Larger text").clicked() {
                ui.ctx()
                    .set_zoom_factor((ui.ctx().zoom_factor() + 0.1).min(1.5));
            }
        });
        ui.add_space(16.0);
        ui.small("v0.1 · Local preview");
    }

    fn network(&mut self, ui: &mut egui::Ui) {
        ui.heading("Your agents. One place.");
        muted(ui, "Keep your tools. Connect their work.");
        ui.add_space(12.0);
        card(ui, |ui| {
            ui.label(
                RichText::new(if self.connection.is_some() {
                    "Bound identity verified"
                } else {
                    "Your Mupot connection starts here"
                })
                .size(20.0)
                .strong(),
            );
            ui.label(if self.connection.is_some() { "Boot context is available for this app. Local runtimes remain separate." } else { "Browse what is on this Mac, then connect an existing Mupot agent with browser approval." });
            if primary(
                ui,
                if self.connection.is_some() {
                    "View connection"
                } else {
                    "Connect an agent"
                },
            )
            .clicked()
            {
                self.page = Page::Connect;
            }
        });
        ui.add_space(8.0);
        ui.horizontal(|ui| {
            ui.label(RichText::new("Local runtimes").size(21.0).strong());
            if ui
                .add_enabled(
                    !self.demo && !self.discovering,
                    egui::Button::new(if self.discovering {
                        "Discovering…"
                    } else {
                        "Refresh"
                    }),
                )
                .clicked()
            {
                self.refresh_discovery(ui.ctx());
            }
        });
        muted(
            ui,
            "Read-only discovery on this computer. These are not verified Mupot identities.",
        );
        ui.add(
            egui::TextEdit::singleline(&mut self.search)
                .hint_text("Search local runtimes and apps")
                .margin(egui::Margin::symmetric(12, 10))
                .desired_width(f32::INFINITY),
        );
        let search = self.search.to_lowercase();
        if self.demo {
            for (name, kind, state) in [
                ("Atlas workshop", "Sample coding runtime", "idle"),
                ("Cedar research", "Sample research runtime", "working"),
            ] {
                if name.to_lowercase().contains(&search) {
                    runtime_card(ui, name, kind, state);
                }
            }
        } else if let Some(discovery) = &self.discovery {
            for runtime in discovery.runtimes.iter().filter(|runtime| {
                format!("{} {}", runtime.name, runtime.kind)
                    .to_lowercase()
                    .contains(&search)
            }) {
                runtime_card(ui, &runtime.name, &runtime.kind, &runtime.state);
            }
            if discovery.runtimes.is_empty() {
                card(ui, |ui| {
                    ui.strong("No local runtimes found");
                    ui.label(format!("Herdr discovery: {:?}.", discovery.herdr_status));
                    muted(
                        ui,
                        "You can still connect an existing Mupot agent. This app does not start runtimes.",
                    );
                });
            }
        } else {
            muted(ui, "Checking local runtime availability…");
        }
        ui.add_space(12.0);
        ui.label(RichText::new("Installed desktop apps").size(21.0).strong());
        muted(
            ui,
            "Installed does not mean connected, running or enrolled.",
        );
        if self.demo {
            card(ui, |ui| {
                ui.strong("Sample desktop tool");
                muted(ui, "Demo installation · not connected");
            });
        } else if let Some(discovery) = &self.discovery {
            for app in discovery
                .apps
                .iter()
                .filter(|app| app.name.to_lowercase().contains(&search))
            {
                card(ui, |ui| {
                    ui.strong(&app.name);
                    muted(ui, "Installed · connection not verified");
                });
            }
            if discovery.apps.is_empty() {
                muted(
                    ui,
                    "No supported desktop apps detected in standard application folders.",
                );
            }
        }
        if let Some(snapshot) = &self.snapshot {
            ui.add_space(16.0);
            ui.label(RichText::new("Accessible squadmates").size(21.0).strong());
            muted(
                ui,
                "Mupot registry context. This is not local runtime or receive status.",
            );
            for member in &snapshot.roster {
                card(ui, |ui| {
                    ui.strong(&member.name);
                    ui.label(&member.role);
                    muted(ui, "Registry entry · runtime not checked");
                });
            }
        }
    }

    fn connect(&mut self, ui: &mut egui::Ui) {
        ui.heading("Connect your agent");
        muted(
            ui,
            "An existing identity. A separate connection for this app.",
        );
        ui.add_space(12.0);
        if let (Some(connection), Some(snapshot)) = (self.connection.clone(), self.snapshot.clone())
        {
            card(ui, |ui| {
                ui.label(
                    RichText::new("Bound identity verified")
                        .color(if self.dark {
                            ACCENT
                        } else {
                            Color32::from_rgb(18, 106, 76)
                        })
                        .strong(),
                );
                ui.label(RichText::new(&snapshot.agent.name).size(25.0).strong());
                ui.label(format!("{} · {}", snapshot.agent.slug, snapshot.agent.role));
                muted(ui, &format!("Bound agent ID: {}", snapshot.agent.id));
                ui.separator();
                for (label, value) in [
                    ("Tenant", &snapshot.tenant),
                    ("Squad", &snapshot.squad.name),
                    ("Channel", &snapshot.channel),
                ] {
                    ui.label(format!("{label}: {value}"));
                }
                muted(
                    ui,
                    &format!(
                        "Registry state: {} · local runtime not verified",
                        snapshot.agent.status
                    ),
                );
                muted(
                    ui,
                    &format!(
                        "Credential expires in {} · {}",
                        remaining_label(connection.expires_unix),
                        self.storage
                    ),
                );
            });
            ui.add_space(8.0);
            ui.add_enabled_ui(!self.pending && !connection.is_expired(), |ui| {
                ui.horizontal_wrapped(|ui| {
                    if primary(ui, "Refresh boot context").clicked() {
                        self.run_connected(ui.ctx(), false);
                    }
                    if ui.button("Check in this app").clicked() {
                        self.run_connected(ui.ctx(), true);
                    }
                });
            });
            muted(
                ui,
                "Check in reports this app’s presence after another identity check. It does not launch a model or enable receiving work.",
            );
            if self.pending {
                ui.label("Verifying with Mupot…");
            }
            ui.add_space(12.0);
            receive_card(ui);
            ui.add_space(12.0);
            if ui.button("Forget this app’s connection…").clicked() {
                self.confirm_forget = true;
            }
            if self.confirm_forget {
                card(ui, |ui| {
                    ui.strong("Forget this connection?");
                    ui.label("Removes only this app’s saved profile and Keychain item, and clears its current connection. It does not revoke the server credential.");
                    ui.horizontal_wrapped(|ui| {
                        if ui.button("Forget connection").clicked() {
                            self.forget();
                        }
                        if ui.button("Keep connection").clicked() {
                            self.confirm_forget = false;
                        }
                    });
                });
            }
            return;
        }
        ui.horizontal_wrapped(|ui| {
            ui.strong("1  Choose your agent");
            ui.label("/");
            ui.label("2  Approve in Mupot");
            ui.label("/");
            ui.label("3  Verify connection");
        });
        ui.add_space(8.0);
        card(ui, |ui| {
            let mut changed = false;
            ui.add_enabled_ui(!self.pending, |ui| {
                ui.label("Mupot address");
                changed |= ui
                    .add(
                        egui::TextEdit::singleline(&mut self.origin)
                            .hint_text("https://your-pot.example")
                            .margin(egui::Margin::symmetric(12, 10))
                            .desired_width(f32::INFINITY),
                    )
                    .changed();
                ui.label("Organization ID");
                changed |= ui
                    .add(
                        egui::TextEdit::singleline(&mut self.tenant)
                            .hint_text("Organization ID provided by your team")
                            .margin(egui::Margin::symmetric(12, 10))
                            .desired_width(f32::INFINITY),
                    )
                    .changed();
                ui.label("Agent name or ID");
                changed |= ui
                    .add(
                        egui::TextEdit::singleline(&mut self.desired)
                            .hint_text("Existing agent name or ID from Mupot")
                            .margin(egui::Margin::symmetric(12, 10))
                            .desired_width(f32::INFINITY),
                    )
                    .changed();
            });
            if changed {
                self.invalidate();
                self.client = None;
            }
            muted(
                ui,
                "Your browser approves a short-lived app credential. Existing tool connections stay separate.",
            );
            ui.small("macOS may ask for Keychain permission when saving, loading or forgetting this app’s credential.");
            if !self.pending {
                ui.horizontal_wrapped(|ui| {
                    if ui
                        .add_enabled(
                            !self.demo,
                            egui::Button::new(RichText::new("Get approval code").color(INK))
                                .fill(ACCENT),
                        )
                        .clicked()
                    {
                        self.start_connection(ui.ctx());
                    }
                    if ui
                        .add_enabled(!self.demo, egui::Button::new("Test connection"))
                        .clicked()
                    {
                        self.invalidate();
                        match PotOrigin::parse(self.origin.trim()).and_then(MupotClient::new) {
                            Ok(client) => {
                                self.pending = true;
                                self.spawn(ui.ctx(), move || Event::Health(client.health()));
                            }
                            Err(error) => self.report_error(error),
                        }
                    }
                });
            }
        });
        if self.pending {
            card(ui, |ui| {
                if let Some(challenge) = self.flow.challenge() {
                    ui.strong("Approve in your browser");
                    ui.label(
                        RichText::new(&challenge.user_code)
                            .monospace()
                            .size(32.0)
                            .color(if self.dark {
                                ACCENT
                            } else {
                                Color32::from_rgb(18, 106, 76)
                            }),
                    );
                    let seconds = self
                        .flow
                        .remaining(Instant::now())
                        .unwrap_or_default()
                        .as_secs();
                    ui.label(format!(
                        "Code expires in {}:{:02}. Waiting for approval…",
                        seconds / 60,
                        seconds % 60
                    ));
                    muted(
                        ui,
                        &format!(
                            "Polling at the server’s interval (at least {} seconds).",
                            challenge.interval.as_secs()
                        ),
                    );
                    if ui.button("Open Mupot approval page").clicked() {
                        ui.ctx()
                            .open_url(egui::OpenUrl::new_tab(challenge.verification_uri.clone()));
                    }
                    muted(ui, &self.origin);
                } else {
                    ui.label("Waiting for Mupot…");
                }
                if ui.button("Cancel").clicked() {
                    self.invalidate();
                    self.log("Connection operation cancelled. Late results will be discarded.");
                }
            });
        }
        if self.demo {
            muted(
                ui,
                "Demo mode: approval, network, local discovery and credential storage are disabled.",
            );
        }
        if !self.profiles.is_empty() && !self.pending {
            ui.add_space(16.0);
            ui.strong("Saved app profiles");
            for profile in self.profiles.clone() {
                card(ui, |ui| {
                    ui.strong(&profile.agent_slug);
                    muted(ui, &format!("{} · {}", profile.tenant, profile.origin));
                    muted(
                        ui,
                        &format!(
                            "Credential expires in {}",
                            remaining_label(profile.expires_unix)
                        ),
                    );
                    ui.horizontal_wrapped(|ui| {
                        if ui.button("Load and verify").clicked() { self.load_profile(ui.ctx(), profile.clone()); }
                        if ui.button("Forget saved profile").clicked() {
                            self.invalidate();
                            match self.repository.as_ref().ok_or(Error::Storage).and_then(|repo| repo.forget(&profile, &KeychainVault)) {
                                Ok(()) => { self.profiles.retain(|p| !(p.origin == profile.origin && p.agent_id == profile.agent_id)); self.log("Saved app profile and its Keychain item removed. Server credential was not revoked."); }
                                Err(error) => self.report_error(error),
                            }
                        }
                    });
                    ui.small("Forget removes this app’s saved item only; it does not revoke the server credential.");
                });
            }
        }
    }

    fn run_connected(&mut self, ctx: &egui::Context, check_in: bool) {
        if self.demo || self.pending {
            return;
        }
        if let (Some(connection), Some(client)) = (self.connection.clone(), self.client.clone()) {
            if connection.is_expired() {
                self.report_error(Error::Expired);
                return;
            }
            self.fence.advance();
            self.pending = true;
            self.error = None;
            self.spawn(ctx, move || {
                if check_in {
                    Event::CheckedIn(client.check_in(&connection))
                } else {
                    Event::Refreshed(client.refresh(&connection))
                }
            });
        }
    }

    fn boot(&mut self, ui: &mut egui::Ui) {
        ui.heading("Boot context");
        muted(
            ui,
            "Read-only context for the verified identity. No commands are executed.",
        );
        ui.add_space(12.0);
        if let Some(snapshot) = &self.snapshot {
            card(ui, |ui| {
                ui.strong(format!("{} · {}", snapshot.agent.name, snapshot.squad.name));
                ui.label(egui::RichText::new(&snapshot.brief).size(16.0));
            });
        } else if self.demo {
            card(ui, |ui| {
                ui.strong("Sample boot brief · no identity verified");
                ui.label("Atlas is a sample workshop agent.\n\nFocus: keep project context clear, report evidence, and ask for review before publishing work.\n\nThis preview does not contain a real agent, credential or server response.");
            });
        } else {
            card(ui, |ui| {
                ui.strong("Connect an agent to load its brief");
                ui.label(
                    "The brief appears only after Mupot verifies the expected agent and tenant.",
                );
                if primary(ui, "Connect an agent").clicked() {
                    self.page = Page::Connect;
                }
            });
        }
        ui.add_space(16.0);
        receive_card(ui);
    }

    fn activity(&self, ui: &mut egui::Ui) {
        ui.heading("Activity");
        muted(
            ui,
            "This app session only. Credentials and approval secrets are never recorded here.",
        );
        ui.add_space(12.0);
        for entry in &self.activity {
            card(ui, |ui| {
                ui.label(entry);
            });
        }
    }
}

impl eframe::App for ConnectApp {
    fn logic(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        self.receive(ctx);
    }
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        egui::Panel::left("navigation")
            .exact_size(216.0)
            .resizable(false)
            .frame(
                egui::Frame::new()
                    .fill(if self.dark {
                        SURFACE
                    } else {
                        Color32::from_rgb(233, 239, 241)
                    })
                    .inner_margin(20),
            )
            .show(ui, |ui| {
                egui::ScrollArea::vertical()
                    .id_salt("sidebar_scroll")
                    .auto_shrink([false, false])
                    .show(ui, |ui| self.sidebar(ui));
            });
        egui::CentralPanel::default()
            .frame(
                egui::Frame::new()
                    .fill(if self.dark {
                        INK
                    } else {
                        Color32::from_rgb(248, 250, 251)
                    })
                    .inner_margin(28),
            )
            .show(ui, |ui| {
                if self.demo {
                    ui.label(
                        RichText::new("DEMO · SAMPLE DATA · OFFLINE")
                            .strong()
                            .color(if self.dark {
                                ACCENT
                            } else {
                                Color32::from_rgb(18, 106, 76)
                            }),
                    );
                    ui.add_space(8.0);
                }
                egui::ScrollArea::vertical()
                    .auto_shrink([false, false])
                    .show(ui, |ui| {
                        ui.set_min_width(ui.available_width());
                        match self.page {
                            Page::Network => self.network(ui),
                            Page::Connect => self.connect(ui),
                            Page::Boot => self.boot(ui),
                            Page::Activity => self.activity(ui),
                        }
                        if let Some(error) = &self.error {
                            ui.add_space(16.0);
                            card(ui, |ui| {
                                ui.label(RichText::new(error).color(if self.dark {
                                    Color32::from_rgb(255, 178, 167)
                                } else {
                                    Color32::from_rgb(155, 38, 24)
                                }));
                            });
                        }
                        ui.add_space(20.0);
                        ui.separator();
                        muted(ui, &self.note);
                    });
            });
    }
}

fn muted(ui: &mut egui::Ui, text: &str) {
    ui.label(
        RichText::new(text)
            .size(14.0)
            .color(if ui.visuals().dark_mode {
                MUTED
            } else {
                Color32::from_rgb(65, 84, 98)
            }),
    );
}
fn primary(ui: &mut egui::Ui, label: &str) -> egui::Response {
    ui.add(egui::Button::new(RichText::new(label).color(INK).strong()).fill(ACCENT))
}
fn card(ui: &mut egui::Ui, content: impl FnOnce(&mut egui::Ui)) {
    egui::Frame::new()
        .fill(if ui.visuals().dark_mode {
            SURFACE
        } else {
            Color32::WHITE
        })
        .stroke(egui::Stroke::new(
            1.0,
            if ui.visuals().dark_mode {
                Color32::from_rgb(52, 71, 85)
            } else {
                Color32::from_rgb(206, 218, 225)
            },
        ))
        .corner_radius(10)
        .inner_margin(20)
        .show(ui, |ui| {
            ui.set_width(ui.available_width());
            content(ui);
        });
}
fn runtime_card(ui: &mut egui::Ui, name: &str, kind: &str, state: &str) {
    card(ui, |ui| {
        // These rows contain text only; the global 44pt control target would
        // otherwise add unnecessary height to every runtime in a long list.
        ui.spacing_mut().interact_size.y = 24.0;
        ui.horizontal_wrapped(|ui| {
            ui.label(RichText::new(name).size(18.0).strong());
            ui.label(format!("Local only · {state}"));
        });
        muted(ui, kind);
    });
}
fn receive_card(ui: &mut egui::Ui) {
    card(ui, |ui| {
        ui.strong("Runtime receive");
        muted(ui, "Not enabled in this build");
        ui.label("This app loads context and can report its own presence. Starting models, consuming inboxes and dispatching work are outside this version.");
    });
}
fn remaining_label(expires_unix: u64) -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let seconds = expires_unix.saturating_sub(now);
    if seconds == 0 {
        "expired".into()
    } else if seconds >= 3600 {
        format!("{}h {}m", seconds / 3600, seconds % 3600 / 60)
    } else {
        format!("{}m {}s", seconds / 60, seconds % 60)
    }
}

fn connection_label(demo: bool, verified: bool) -> &'static str {
    if demo {
        "Demo · sample data"
    } else if verified {
        "App identity verified"
    } else {
        "Not connected"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancellation_rejects_worker_result_before_persistence() {
        let mut fence = OperationFence::default();
        let op = fence.advance();
        fence.advance();
        let mut saved = false;
        if fence.accepts(op) {
            saved = true;
        }
        assert!(!saved);
    }
    #[test]
    fn forget_and_origin_change_fence_out_prior_connection() {
        let mut fence = OperationFence::default();
        let original = fence.advance();
        fence.advance(); // forget
        let changed_origin = fence.advance();
        assert!(!fence.accepts(original));
        assert!(fence.accepts(changed_origin));
    }
    #[test]
    fn expired_saved_profile_has_no_positive_lifetime() {
        assert_eq!(remaining_label(1), "expired");
    }

    #[test]
    fn cancelled_worker_result_cannot_overwrite_current_ui() {
        let ctx = egui::Context::default();
        let mut app = ConnectApp::with_context(&ctx, true, "connect", false);
        let generation = app.fence.advance();
        app.pending = true;
        app.invalidate();
        app.note = "Cancelled by user".into();
        app.tx
            .send(WorkerResult {
                generation,
                event: Event::Restored(Err(Error::IdentityMismatch)),
            })
            .unwrap();
        app.receive(&ctx);
        assert_eq!(app.note, "Cancelled by user");
        assert!(!app.pending);
        assert!(app.error.is_none());
        assert!(app.connection.is_none());
        assert!(app.snapshot.is_none());
        assert!(app.storage.is_empty());
    }

    #[test]
    fn demo_never_initializes_real_discovery_or_storage() {
        let ctx = egui::Context::default();
        let mut app = ConnectApp::with_context(&ctx, true, "network", false);
        app.refresh_discovery(&ctx);
        app.start_connection(&ctx);
        assert!(app.repository.is_none());
        assert!(app.profiles.is_empty());
        assert!(app.discovery.is_none());
        assert!(!app.discovering);
        assert!(!app.pending);
        assert!(app.rx.try_recv().is_err());
    }

    #[test]
    fn status_never_claims_booted_or_receive_ready() {
        assert_eq!(connection_label(false, false), "Not connected");
        assert_eq!(connection_label(false, true), "App identity verified");
        assert_eq!(connection_label(true, true), "Demo · sample data");
    }

    #[test]
    fn forget_invalidates_queued_refresh_and_clears_transient_state() {
        let ctx = egui::Context::default();
        let mut app = ConnectApp::with_context(&ctx, true, "connect", false);
        let generation = app.fence.advance();
        app.pending = true;
        app.storage = "old storage message".into();
        app.forget();
        app.tx
            .send(WorkerResult {
                generation,
                event: Event::Refreshed(Err(Error::Transport)),
            })
            .unwrap();
        app.receive(&ctx);
        assert!(app.storage.is_empty());
        assert!(!app.pending);
        assert!(app.error.is_none());
        assert!(app.note.contains("forgotten"));
    }
}
