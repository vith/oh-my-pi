use std::{cell::RefCell, os::fd::OwnedFd, rc::Rc};

use ashpd::desktop::{
	PersistMode,
	screencast::{CursorMode, Screencast, SourceType},
};
use image::RgbaImage;
use pipewire as pw;
use pw::{properties::properties, spa};
use xxhash_rust::xxh64::xxh64;

use super::portal::{read_token, store_token};
use crate::desktop::error::{CoreResult, DesktopError};

const SCREENCAST_TOKEN: &str = "screencast-token";

pub(super) enum CaptureSource {
	Monitor,
	Window { token_name: String },
}

pub(super) fn window_token_name(app: &str) -> String {
	format!("screencast-window-{:016x}", xxh64(app.as_bytes(), 0))
}

#[derive(Debug, Clone, Copy)]
pub(super) struct StreamGeometry {
	pub x:      i32,
	pub y:      i32,
	pub width:  u32,
	pub height: u32,
}

pub(super) struct CapturedFrame {
	pub image:    RgbaImage,
	pub geometry: StreamGeometry,
}

async fn open_screencast(
	source: &CaptureSource,
) -> Result<(u32, OwnedFd, Option<StreamGeometry>), String> {
	let portal = Screencast::new()
		.await
		.map_err(|err| format!("ScreenCast portal: {err}"))?;
	let session = portal
		.create_session()
		.await
		.map_err(|err| format!("ScreenCast CreateSession: {err}"))?;
	let source_types = match source {
		CaptureSource::Monitor => SourceType::Monitor.into(),
		CaptureSource::Window { .. } => SourceType::Window.into(),
	};
	if matches!(source, CaptureSource::Window { .. }) {
		let available = portal
			.available_source_types()
			.await
			.map_err(|err| format!("ScreenCast AvailableSourceTypes: {err}"))?;
		if !available.contains(SourceType::Window) {
			return Err("ScreenCast portal does not support window sources".to_string());
		}
	}
	let multiple = matches!(source, CaptureSource::Monitor);
	let token_name = match source {
		CaptureSource::Monitor => SCREENCAST_TOKEN,
		CaptureSource::Window { token_name } => token_name.as_str(),
	};
	let restore_token = read_token(token_name);
	portal
		.select_sources(
			&session,
			CursorMode::Embedded,
			source_types,
			multiple,
			restore_token.as_deref(),
			PersistMode::ExplicitlyRevoked,
		)
		.await
		.map_err(|err| format!("ScreenCast SelectSources: {err}"))?;
	let response = portal
		.start(&session, None)
		.await
		.map_err(|err| format!("ScreenCast Start: {err}"))?
		.response()
		.map_err(|err| format!("ScreenCast permission: {err}"))?;
	store_token(token_name, response.restore_token());
	let stream = response
		.streams()
		.first()
		.ok_or_else(|| "ScreenCast returned no source stream".to_string())?;
	if matches!(source, CaptureSource::Window { .. })
		&& stream.source_type() == Some(SourceType::Monitor)
	{
		return Err("ScreenCast returned a monitor stream for a window request".to_string());
	}
	let geometry = stream.size().and_then(|(width, height)| {
		let (Ok(width), Ok(height)) = (u32::try_from(width), u32::try_from(height)) else {
			return None;
		};
		if width == 0 || height == 0 {
			return None;
		}
		let (x, y) = stream.position().unwrap_or((0, 0));
		Some(StreamGeometry { x, y, width, height })
	});
	let node = stream.pipe_wire_node_id();
	let fd = portal
		.open_pipe_wire_remote(&session)
		.await
		.map_err(|err| format!("ScreenCast OpenPipeWireRemote: {err}"))?;
	Ok((node, fd, geometry))
}

struct UserData {
	format: spa::param::video::VideoInfoRaw,
}

fn rgba_from_buffer(
	format: &spa::param::video::VideoInfoRaw,
	data: &mut pw::spa::buffer::Data,
) -> Result<RgbaImage, String> {
	let size = format.size();
	let width = size.width;
	let height = size.height;
	if width == 0 || height == 0 {
		return Err("PipeWire negotiated an empty frame".to_string());
	}
	let chunk = data.chunk();
	let offset = chunk.offset() as usize;
	let bytes = chunk.size() as usize;
	let stride = chunk.stride();
	if stride <= 0 {
		return Err(format!("PipeWire returned unsupported frame stride {stride}"));
	}
	let stride = stride as usize;
	let source = data
		.data()
		.ok_or_else(|| "PipeWire frame buffer is not memory-mapped".to_string())?;
	let end = offset
		.checked_add(bytes)
		.ok_or_else(|| "PipeWire frame size overflow".to_string())?
		.min(source.len());
	let source = source
		.get(offset..end)
		.ok_or_else(|| "PipeWire frame offset is outside the mapped buffer".to_string())?;
	let pixel_size = match format.format() {
		spa::param::video::VideoFormat::RGB | spa::param::video::VideoFormat::BGR => 3,
		spa::param::video::VideoFormat::RGBA
		| spa::param::video::VideoFormat::RGBx
		| spa::param::video::VideoFormat::BGRA
		| spa::param::video::VideoFormat::BGRx => 4,
		other => return Err(format!("PipeWire negotiated unsupported pixel format {other:?}")),
	};
	let row_bytes = (width as usize)
		.checked_mul(pixel_size)
		.ok_or_else(|| "PipeWire row size overflow".to_string())?;
	if stride < row_bytes || source.len() < stride.saturating_mul(height as usize) {
		return Err(format!(
			"PipeWire frame buffer is short: {} bytes for {width}x{height} stride {stride}",
			source.len()
		));
	}
	let mut rgba = vec![
		0;
		(width as usize)
			.saturating_mul(height as usize)
			.saturating_mul(4)
	];
	for y in 0..height as usize {
		let row = &source[y * stride..y * stride + row_bytes];
		for x in 0..width as usize {
			let input = &row[x * pixel_size..];
			let output = &mut rgba[(y * width as usize + x) * 4..];
			match format.format() {
				spa::param::video::VideoFormat::RGB
				| spa::param::video::VideoFormat::RGBA
				| spa::param::video::VideoFormat::RGBx => {
					output[..4].copy_from_slice(&[
						input[0],
						input[1],
						input[2],
						if pixel_size == 4 && format.format() == spa::param::video::VideoFormat::RGBA {
							input[3]
						} else {
							255
						},
					]);
				},
				_ => output[..4].copy_from_slice(&[
					input[2],
					input[1],
					input[0],
					if pixel_size == 4 && format.format() == spa::param::video::VideoFormat::BGRA {
						input[3]
					} else {
						255
					},
				]),
			}
		}
	}
	RgbaImage::from_raw(width, height, rgba)
		.ok_or_else(|| "failed to construct PipeWire RGBA frame".to_string())
}

fn crop_transparent_padding(image: RgbaImage) -> RgbaImage {
	let mut min_x = image.width();
	let mut min_y = image.height();
	let mut max_x = 0;
	let mut max_y = 0;
	let mut has_visible_pixel = false;
	for (x, y, pixel) in image.enumerate_pixels() {
		if pixel.0[3] == 0 {
			continue;
		}
		has_visible_pixel = true;
		min_x = min_x.min(x);
		min_y = min_y.min(y);
		max_x = max_x.max(x);
		max_y = max_y.max(y);
	}
	if !has_visible_pixel {
		return image;
	}
	image::imageops::crop_imm(&image, min_x, min_y, max_x - min_x + 1, max_y - min_y + 1).to_image()
}

fn grab_pipewire_frame(node: u32, fd: OwnedFd) -> Result<RgbaImage, String> {
	pw::init();
	let mainloop =
		pw::main_loop::MainLoopRc::new(None).map_err(|err| format!("PipeWire main loop: {err}"))?;
	let context = pw::context::ContextRc::new(&mainloop, None)
		.map_err(|err| format!("PipeWire context: {err}"))?;
	let core = context
		.connect_fd_rc(fd, None)
		.map_err(|err| format!("PipeWire remote: {err}"))?;
	let stream = pw::stream::StreamBox::new(&core, "omp-computer-capture", properties! {
		*pw::keys::MEDIA_TYPE => "Video",
		*pw::keys::MEDIA_CATEGORY => "Capture",
		*pw::keys::MEDIA_ROLE => "Screen",
	})
	.map_err(|err| format!("PipeWire stream: {err}"))?;
	let result: Rc<RefCell<Option<Result<RgbaImage, String>>>> = Rc::new(RefCell::new(None));
	let callback_result = Rc::clone(&result);
	let callback_loop = mainloop.clone();
	let _listener = stream
		.add_local_listener_with_user_data(UserData { format: Default::default() })
		.param_changed(|_, user, id, param| {
			let Some(param) = param else {
				return;
			};
			if id == spa::param::ParamType::Format.as_raw() {
				let _ = user.format.parse(param);
			}
		})
		.process(move |stream, user| {
			let Some(mut buffer) = stream.dequeue_buffer() else {
				return;
			};
			let Some(data) = buffer.datas_mut().first_mut() else {
				return;
			};
			*callback_result.borrow_mut() = Some(rgba_from_buffer(&user.format, data));
			callback_loop.quit();
		})
		.register()
		.map_err(|err| format!("PipeWire listener: {err}"))?;
	let object = spa::pod::object!(
		spa::utils::SpaTypes::ObjectParamFormat,
		spa::param::ParamType::EnumFormat,
		spa::pod::property!(
			spa::param::format::FormatProperties::MediaType,
			Id,
			spa::param::format::MediaType::Video
		),
		spa::pod::property!(
			spa::param::format::FormatProperties::MediaSubtype,
			Id,
			spa::param::format::MediaSubtype::Raw
		),
		spa::pod::property!(
			spa::param::format::FormatProperties::VideoFormat,
			Choice,
			Enum,
			Id,
			spa::param::video::VideoFormat::BGRx,
			spa::param::video::VideoFormat::BGRx,
			spa::param::video::VideoFormat::BGRA,
			spa::param::video::VideoFormat::RGBx,
			spa::param::video::VideoFormat::RGBA,
			spa::param::video::VideoFormat::RGB,
			spa::param::video::VideoFormat::BGR
		),
		spa::pod::property!(
			spa::param::format::FormatProperties::VideoSize,
			Choice,
			Range,
			Rectangle,
			spa::utils::Rectangle { width: 1920, height: 1080 },
			spa::utils::Rectangle { width: 1, height: 1 },
			spa::utils::Rectangle { width: 16384, height: 16384 }
		)
	);
	let values = spa::pod::serialize::PodSerializer::serialize(
		std::io::Cursor::new(Vec::new()),
		&spa::pod::Value::Object(object),
	)
	.map_err(|err| format!("PipeWire format serialization: {err}"))?
	.0
	.into_inner();
	let param = spa::pod::Pod::from_bytes(&values)
		.ok_or_else(|| "PipeWire rejected format parameters".to_string())?;
	stream
		.connect(
			spa::utils::Direction::Input,
			Some(node),
			pw::stream::StreamFlags::AUTOCONNECT | pw::stream::StreamFlags::MAP_BUFFERS,
			&mut [param],
		)
		.map_err(|err| format!("PipeWire connect: {err}"))?;
	mainloop.run();
	result
		.borrow_mut()
		.take()
		.unwrap_or_else(|| Err("PipeWire stream ended before producing a frame".to_string()))
}

pub(super) fn capture(source: CaptureSource) -> CoreResult<CapturedFrame> {
	let runtime = super::portal::portal_runtime()?;
	let (node, fd, stream_geometry) = runtime.block_on(open_screencast(&source)).map_err(|err| {
		DesktopError::capture_failed(format!("wayland screencast unavailable: {err}"))
	})?;
	let mut image = grab_pipewire_frame(node, fd)
		.map_err(|err| DesktopError::capture_failed(format!("wayland screencast failed: {err}")))?;
	if matches!(source, CaptureSource::Window { .. }) {
		image = crop_transparent_padding(image);
	}
	let geometry = stream_geometry.unwrap_or(StreamGeometry {
		x:      0,
		y:      0,
		width:  image.width(),
		height: image.height(),
	});
	Ok(CapturedFrame { image, geometry })
}

#[cfg(test)]
mod tests {
	use image::Rgba;

	use super::*;

	#[test]
	fn window_frame_crop_removes_transparent_padding() {
		let mut image = RgbaImage::from_pixel(8, 6, Rgba([0, 0, 0, 0]));
		for y in 1..5 {
			for x in 2..7 {
				image.put_pixel(x, y, Rgba([255, 0, 0, 255]));
			}
		}

		let cropped = crop_transparent_padding(image);

		assert_eq!(cropped.dimensions(), (5, 4));
		assert!(cropped.pixels().all(|pixel| pixel.0[3] == 255));
	}

	#[test]
	fn window_capture_token_is_stable_across_title_changes() {
		let first = window_token_name("org.example.Editor");
		let second = window_token_name("org.example.Editor");
		let different_app = window_token_name("org.example.Preview");

		assert_eq!(first, second);
		assert_ne!(first, different_app);
		assert!(first.starts_with("screencast-window-"));
	}
}
