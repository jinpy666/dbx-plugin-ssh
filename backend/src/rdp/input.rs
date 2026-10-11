//! 键鼠输入映射（NyaTerm rdp_input_to_fast_path_input 同源）：扫描码
//! （XT set 1 + extended）、鼠标键名、滚轮取反、unicode 成对展开与
//! 输入数据库维护。协议扫描码空间 u8，越界拒绝不截断（E5b）。
use super::wire::RdpWireInput;
use ironrdp::client::rdp::RdpInputEvent as IronRdpInputEvent;
use ironrdp::input::{
    Database as IronRdpInputDatabase, MouseButton as IronRdpMouseButton,
    MousePosition as IronRdpMousePosition, Operation as IronRdpInputOperation,
    Scancode as IronRdpScancode, WheelRotations as IronRdpWheelRotations,
};
use ironrdp::pdu::input::fast_path::{
    FastPathInputEvent as IronRdpFastPathInputEvent, KeyboardFlags as IronRdpKeyboardFlags,
};
use smallvec::SmallVec;
use tokio::sync::mpsc;

/// Right-shift scancode gets a direct fast-path event (NyaTerm bug fix: the
/// input database treats it as the extended left-shift on some layouts).
/// The protocol scancode space is u8; larger wire values are rejected, not
/// truncated (E5b, rdp-security-review).
pub(crate) const RDP_RIGHT_SHIFT_SCAN_CODE: u8 = 0x36;

// —— input mapping (NyaTerm's rdp_input_to_fast_path_input) ——

pub(crate) enum InputAction {
    Operations(Vec<IronRdpInputOperation>),
    FastPath(IronRdpFastPathInputEvent),
}

pub(crate) fn wire_input_to_action(input: RdpWireInput) -> Option<InputAction> {
    match input {
        RdpWireInput::KeyDown {
            scan_code,
            extended,
        } if is_right_shift_scan_code(scan_code, extended) => Some(InputAction::FastPath(
            IronRdpFastPathInputEvent::KeyboardEvent(
                IronRdpKeyboardFlags::empty(),
                RDP_RIGHT_SHIFT_SCAN_CODE,
            ),
        )),
        RdpWireInput::KeyDown {
            scan_code,
            extended,
        } => Some(InputAction::Operations(vec![
            IronRdpInputOperation::KeyPressed(IronRdpScancode::from_u8(extended, scan_code)),
        ])),
        RdpWireInput::KeyUp {
            scan_code,
            extended,
        } if is_right_shift_scan_code(scan_code, extended) => Some(InputAction::FastPath(
            IronRdpFastPathInputEvent::KeyboardEvent(
                IronRdpKeyboardFlags::RELEASE,
                RDP_RIGHT_SHIFT_SCAN_CODE,
            ),
        )),
        RdpWireInput::KeyUp {
            scan_code,
            extended,
        } => Some(InputAction::Operations(vec![
            IronRdpInputOperation::KeyReleased(IronRdpScancode::from_u8(extended, scan_code)),
        ])),
        RdpWireInput::MouseMove { x, y } => Some(InputAction::Operations(vec![
            IronRdpInputOperation::MouseMove(IronRdpMousePosition {
                x: clamp_u32_to_u16(x),
                y: clamp_u32_to_u16(y),
            }),
        ])),
        RdpWireInput::MouseButton {
            button,
            pressed,
            x,
            y,
        } => {
            let Some(button) = ironrdp_mouse_button(&button) else {
                return Some(InputAction::Operations(Vec::new()));
            };
            let mut operations = vec![IronRdpInputOperation::MouseMove(IronRdpMousePosition {
                x: clamp_u32_to_u16(x),
                y: clamp_u32_to_u16(y),
            })];
            operations.push(if pressed {
                IronRdpInputOperation::MouseButtonPressed(button)
            } else {
                IronRdpInputOperation::MouseButtonReleased(button)
            });
            Some(InputAction::Operations(operations))
        }
        RdpWireInput::MouseWheel {
            delta_x,
            delta_y,
            x,
            y,
        } => {
            let mut operations = vec![IronRdpInputOperation::MouseMove(IronRdpMousePosition {
                x: clamp_u32_to_u16(x),
                y: clamp_u32_to_u16(y),
            })];
            if delta_x.abs() > 0.001 {
                operations.push(IronRdpInputOperation::WheelRotations(
                    IronRdpWheelRotations {
                        is_vertical: false,
                        rotation_units: clamp_f64_to_i16(-delta_x),
                    },
                ));
            }
            if delta_y.abs() > 0.001 {
                operations.push(IronRdpInputOperation::WheelRotations(
                    IronRdpWheelRotations {
                        is_vertical: true,
                        rotation_units: clamp_f64_to_i16(-delta_y),
                    },
                ));
            }
            Some(InputAction::Operations(operations))
        }
        RdpWireInput::Unicode { text } => {
            let mut operations = Vec::new();
            for character in text.chars() {
                operations.push(IronRdpInputOperation::UnicodeKeyPressed(character));
                operations.push(IronRdpInputOperation::UnicodeKeyReleased(character));
            }
            Some(InputAction::Operations(operations))
        }
        RdpWireInput::ReleaseAll => None,
    }
}

pub(crate) fn is_right_shift_scan_code(scan_code: u8, extended: bool) -> bool {
    !extended && scan_code == RDP_RIGHT_SHIFT_SCAN_CODE
}

pub(crate) fn ironrdp_mouse_button(button: &str) -> Option<IronRdpMouseButton> {
    match button {
        "left" => Some(IronRdpMouseButton::Left),
        "middle" => Some(IronRdpMouseButton::Middle),
        "right" => Some(IronRdpMouseButton::Right),
        "back" => Some(IronRdpMouseButton::X1),
        "forward" => Some(IronRdpMouseButton::X2),
        _ => None,
    }
}

fn clamp_u32_to_u16(value: u32) -> u16 {
    u16::try_from(value).unwrap_or(u16::MAX)
}

fn clamp_f64_to_i16(value: f64) -> i16 {
    if value.is_nan() {
        return 0;
    }
    value.clamp(f64::from(i16::MIN), f64::from(i16::MAX)) as i16
}

/// Feeds one wire input through NyaTerm's mapping (right-shift direct
/// fast-path, everything else via the input database) and pushes the
/// resulting fast-path events to the engine.
pub(crate) fn send_wire_input(
    input_sender: &mpsc::UnboundedSender<IronRdpInputEvent>,
    database: &mut IronRdpInputDatabase,
    input: RdpWireInput,
) -> Result<(), String> {
    let fast_path: SmallVec<[IronRdpFastPathInputEvent; 2]> = match wire_input_to_action(input) {
        Some(InputAction::Operations(operations)) => database.apply(operations),
        Some(InputAction::FastPath(event)) => smallvec::smallvec![event],
        None => database.release_all(),
    };
    if !fast_path.is_empty()
        && input_sender
            .send(IronRdpInputEvent::FastPath(fast_path))
            .is_err()
    {
        return Err("RDP input channel is closed".to_string());
    }
    Ok(())
}
