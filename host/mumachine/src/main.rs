mod ui;

fn main() -> eframe::Result {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let demo = args.iter().any(|arg| arg == "--demo");
    let page = args
        .iter()
        .find_map(|arg| arg.strip_prefix("--page="))
        .unwrap_or("network")
        .to_owned();
    let compact = args.iter().any(|arg| arg == "--compact");
    let light = args.iter().any(|arg| arg == "--light");
    let options = eframe::NativeOptions {
        viewport: eframe::egui::ViewportBuilder::default()
            .with_icon(
                eframe::icon_data::from_png_bytes(include_bytes!(
                    "../../../src/dashboard/brand/mupot-mark-64.png"
                ))
                .expect("bundled Mupot mark"),
            )
            .with_inner_size(if compact {
                [880.0, 640.0]
            } else {
                [1160.0, 780.0]
            })
            .with_min_inner_size([880.0, 640.0]),
        renderer: eframe::Renderer::Glow,
        ..Default::default()
    };
    eframe::run_native(
        "Mupot Connect",
        options,
        Box::new(move |cc| Ok(Box::new(ui::ConnectApp::new(cc, demo, &page, light)))),
    )
}
