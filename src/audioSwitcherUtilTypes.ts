import { SoundSwitchSettings } from "./settings"

export enum DeviceState {
    ACTIVE = 0x00000001,
    DISABLED = 0x00000002,
    NOTPRESENT = 0x00000004,
    UNPLUGGED = 0x00000008,
    MASK_ALL = 0x0000000f
}

export enum DataFlow {
    eRender = 0,
    eCapture = 1,
    eAll = 2,
    eCount = 3
}

export interface DeviceInfo {
    DeviceId: string,
    DeviceName: string
    State: DeviceState
    DataFlow: DataFlow
}

export interface ActionDeviceInfo {
    settings: SoundSwitchSettings,
    devices: DeviceInfo[],
    curDeviceIdx: number
}

export interface IMessage {
}

export class DevicesMessageRequest implements IMessage {
    constructor(
        public DataFlow: DataFlow
    ) { }
}

export class DevicesMessageResponse implements IMessage {
    constructor(
        public Devices: DeviceInfo[]
    ) { }
}

export class FocusedMessageRequest implements IMessage {
    constructor(
        public Icon: boolean,
        public ProcessId?: number
    ) { }
}

export class FocusedMessageResponse implements IMessage {
    constructor(
        public ProcessId: number,
        public ProcessName: string,
        public DeviceId: string,
        public HasSession: boolean,
        public ProcessIconBase64?: string
    ) { }
}

export class SetAppDeviceMessageRequest implements IMessage {
    constructor(
        public ProcessId: Number,
        public DeviceId: string
    ) { }
}

export class SetAppDeviceMessagResponse implements IMessage {
    constructor(
        public Success: boolean
    ) { }
}