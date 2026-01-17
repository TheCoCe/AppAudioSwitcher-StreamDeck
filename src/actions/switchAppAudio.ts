import streamDeck, { Action, action, DialRotateEvent, DidReceiveSettingsEvent, KeyDownEvent, KeyUpEvent, SingletonAction, WillAppearEvent, WillDisappearEvent, type SendToPluginEvent } from "@elgato/streamdeck";
import { JsonValue } from "@elgato/utils";
import type { DataSourcePayload, DataSourceResult } from "../sdpi";
import type { DialAction, DialDownEvent, KeyAction } from "@elgato/streamdeck";
import { ChildProcess, exec, ExecException, spawn } from 'child_process';
import { GlobalSettings, SoundSwitchSettings } from "../settings";
import { Socket } from "net";
import path from "path";

enum DeviceState {
	ACTIVE = 0x00000001,
	DISABLED = 0x00000002,
	NOTPRESENT = 0x00000004,
	UNPLUGGED = 0x00000008,
	MASK_ALL = 0x0000000f
}

enum DataFlow {
	eRender = 0,
	eCapture = 1,
	eAll = 2,
	eCount = 3
}

type AudioDevice = {
	Id: string,
	Name: string
	State: DeviceState
	Flow: DataFlow
}

type ActionDeviceInfo = {
	settings: SoundSwitchSettings,
	devices: AudioDevice[],
	curDeviceIdx: number
}

type Response = {
	id: string,
	payload: Object
}

type DevicesPayload = {
	devices: AudioDevice[]
}

type FocusedPayload = {
	processId: number,
	processName: string,
	deviceId: string,
	hasSession: boolean
	processIconBase64?: string
}

/**
 * An example action class that displays a count that increments by one each time the button is pressed.
 */
@action({ UUID: "com.serafin-kaiser.appaudioswitcher.switchappaudio" })
export class SwitchAppAudioAction extends SingletonAction<SoundSwitchSettings> {
	private curDevices: Array<AudioDevice> = new Array();
	private timer: NodeJS.Timeout | undefined;
	private processInfo: FocusedPayload | undefined;
	private forceProcessUpdate: boolean = false;

	// --- Utils Server ---

	private utilsServerProcess: ChildProcess | null = null;
	private client: Socket | null = null;

	async tryLaunchUtilsServer(restart: boolean = false): Promise<void> {
		if(restart) {
			this.endUtilsServer();
		}

		if(this.utilsServerProcess !== null) {
			return;
		}

		return new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.utilsServerProcess?.kill();
				this.utilsServerProcess = null;
				reject(new Error("Server startup timed out")) 
			}, 5000);

			try {
				this.utilsServerProcess = spawn(path.join(import.meta.dirname + "\\..\\audioSwitcherUtil\\AppAudioSwitcherUtility.exe"), ["--server"]);
				this.utilsServerProcess.stdout?.on("data", (data) => {
					const text = data.toString();
					if(text.includes("Listening on port")) {
						clearTimeout(timeout)
						resolve();
					}
				});
			}
			catch (e) {
				clearTimeout(timeout);
				reject(e);
			}
		})
	}

	endUtilsServer() {
		this.client?.write("close");
		this.client?.end();
		this.client = null;

		if(this.utilsServerProcess !== null) {
			this.utilsServerProcess.kill();
		}
	}

	isConnected() {
		if(this.utilsServerProcess == null) {
			return false;
		}
		if(this.client == null) {
			return false;
		}
		return true;
	}

	async tryConnectToUtilsServer(skipLaunch: boolean = false): Promise<void> {
		return new Promise<void>(async (resolve, reject) => {
			if(this.isConnected())
			{
				resolve();
				return;
			}

			const connectHandler = () => {
				if(this.client !== null) {
					this.client.end();
					this.client = null;
				}

				this.client = new Socket();

				this.client.on("data", (data) => {
					this.messageReceived(data.toString());
				})
 
				try {
					this.client.connect(32122, "127.0.0.1", () => {
						streamDeck.logger.info("Connected to Utils!");
						resolve();
					});
				} catch (e) {
					this.endUtilsServer();
					reject(e);
				}
			}
			
			if(skipLaunch) {
				connectHandler();
			}
			else 
			{
				this.tryLaunchUtilsServer().then(() => {
					connectHandler();
				}, (e) => {
					reject(e);
				});
			}
		});
	}

	async sendMessage(message: string) {
		await this.tryConnectToUtilsServer(true);
		if(this.client === undefined) {
			streamDeck.logger.debug("Fail!");
		}
		streamDeck.logger.debug(`Sending Message: ${message}`);
		this.client?.write(message);
	}

	async messageReceived(message: string) {
		streamDeck.logger.info(`Received message: ${message}`);

		let response: Response;

		try {
			response = JSON.parse(message);
		}
		catch {
			return;
		}

		switch (response.id) {
			case "devices": {
				await this.handleDevicesMessageReceived(response.payload as DevicesPayload);
				break;
			}
			case "focused":
			case "icon":
			{
				await this.handleFocusedMessageReceived(response.payload as FocusedPayload);
				break;
			}
		}
	}

	async handleDevicesMessageReceived(devicesPayload: DevicesPayload) {
		this.curDevices = devicesPayload.devices ?? [];
		streamDeck.logger.info(devicesPayload);
		// After receiving devices, immediately update process
		await this.sendMessage("--get focused --icon");
	}

	async handleFocusedMessageReceived(focusedPayload: FocusedPayload) {
		if(focusedPayload === undefined) return;

		if(((focusedPayload.processId !== this.processInfo?.processId 
			|| focusedPayload.hasSession !== this.processInfo.hasSession 
			|| focusedPayload.deviceId !== this.processInfo.deviceId) 
			&& focusedPayload.processId !== 0) 
			|| this.forceProcessUpdate)
		{
			this.forceProcessUpdate = false;
			this.processInfo = {
				processId: focusedPayload.processId,
				processName: focusedPayload.processName,
				deviceId: focusedPayload.deviceId,
				hasSession: focusedPayload.hasSession,
				// icon is only sent when the process changes, updates do not include it, so make sure to preserve the icon when updates for the process come in
				processIconBase64: this.processInfo?.processId == focusedPayload.processId && !focusedPayload.processIconBase64 ? this.processInfo.processIconBase64 : focusedPayload.processIconBase64
			};

			for (const action of this.actions) {
				action.setTitle(this.processInfo.processName);
				if(action.isDial())
				{
					if(this.processInfo.deviceId !== '') {
						await this.trySetCurSelectedDeviceId(action, this.processInfo.deviceId);
					}

					this.updateDialLayout(action).then();

					if(focusedPayload.processIconBase64 !== undefined) {
						action.setFeedback({
							icon: `data:image/png;base64,${focusedPayload.processIconBase64}`
						}).then()
					}
				}
			}
		}
	}

	async execAwait(cmd: string): Promise<{ error: ExecException|null; stdout: string; stderr: string }> 
	{ 
		return new Promise((resolve) => { 
			exec(cmd, (error, stdout, stderr) => { 
				resolve({ error, stdout, stderr }); 
			}); 
		}); 
	}

	private async updateDialLayout(action: DialAction<SoundSwitchSettings>) {
		// Update 
		const deviceInfo = await this.getCurDeviceForAction(action);

		if(this.processInfo?.hasSession || this.processInfo?.deviceId !== "") {
			await action.setFeedback({
				value: deviceInfo?.Name.toString() ?? "None",
			});
		}
		else {
			await action.setFeedback({
				value: "-",
			})
		}
	}

	private async getActionDeviceData(action: DialAction<SoundSwitchSettings> | KeyAction<SoundSwitchSettings>, filter: DeviceState = DeviceState.MASK_ALL): Promise<ActionDeviceInfo|null>
	{
		if(action === undefined) return null;
		const settings = await action?.getSettings();
		if(settings === undefined) return null;
		const devicesForAction = this.curDevices.filter((d) => settings.activeDevices?.includes(d.Id) && d.State & filter);
		let deviceIndex = devicesForAction.findIndex((d) => (d.Id === settings.curSelectedDeviceId));
		return { settings: settings, devices: devicesForAction, curDeviceIdx: deviceIndex };
	}

	private async getCurDeviceForAction(action: DialAction<SoundSwitchSettings> | KeyAction<SoundSwitchSettings>): Promise<AudioDevice|undefined> {
		const actionDeviceInfo = await this.getActionDeviceData(action);
		if(actionDeviceInfo === null) return undefined;

		let idx = actionDeviceInfo?.curDeviceIdx ?? 0;
		if(actionDeviceInfo.devices.length == 0) return undefined;
		if(idx < 0 || idx >= actionDeviceInfo.devices.length) {
			idx = 0;
		}
	
		const deviceInfo = this.curDevices.find((d) => d.Id === actionDeviceInfo.devices[idx]?.Id);
		return deviceInfo;
	}

	private async trySetCurSelectedDeviceId(action: DialAction<SoundSwitchSettings> | KeyAction<SoundSwitchSettings>, deviceId: string) {
		let activationDeviceInfo = await this.getActionDeviceData(action);
		if(activationDeviceInfo === null) return;

		const device = activationDeviceInfo.devices.find((d) => d.Id === deviceId);
		if(device !== undefined) {
			activationDeviceInfo.settings.curSelectedDeviceId = deviceId;
			await action.setSettings(activationDeviceInfo.settings);
		}
	}

	private async cycleDeviceIndexForAction(action: DialAction<SoundSwitchSettings> | KeyAction<SoundSwitchSettings>, incr: boolean) {
		let actionDeviceInfo = await this.getActionDeviceData(action, DeviceState.ACTIVE);
		if(actionDeviceInfo === null) return;
		if(actionDeviceInfo.devices.length == 0) {
			streamDeck.logger.info("No devices to switch to!");
			return;
		}

		let idx = actionDeviceInfo.curDeviceIdx;
		idx = idx + (incr ? 1 : -1);
		if(idx < 0) {
			idx = actionDeviceInfo.devices.length - 1;
		}
		else if(idx >= actionDeviceInfo.devices.length) {
			idx = 0;
		}

		actionDeviceInfo.settings.curSelectedDeviceId = actionDeviceInfo.devices[idx].Id;
		await action.setSettings(actionDeviceInfo.settings);
	}

	/**
	 * The {@link SingletonAction.onWillAppear} event is useful for setting the visual representation of an action when it becomes visible. This could be due to the Stream Deck first
	 * starting up, or the user navigating between pages / folders etc.. There is also an inverse of this event in the form of {@link streamDeck.client.onWillDisappear}. In this example,
	 * we're setting the title to the "count" that is incremented in {@link SwitchAppAudioAction.onKeyDown}.
	 */
	override async onWillAppear(ev: WillAppearEvent<SoundSwitchSettings>): Promise<void> {
		try {
			await this.tryConnectToUtilsServer(true);
		}
		catch (e) {
			streamDeck.logger.error(e);
			return;
		}

		await this.sendMessage("--get devices");
	}

	override onWillDisappear(ev: WillDisappearEvent<SoundSwitchSettings>): Promise<void> | void {
		if(this.actions.next().done) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	/**
	 * Listens for the {@link SingletonAction.onKeyDown} event which is emitted by Stream Deck when an action is pressed. Stream Deck provides various events for tracking interaction
	 * with devices including key down/up, dial rotations, and device connectivity, etc. When triggered, {@link ev} object contains information about the event including any payloads
	 * and action information where applicable. In this example, our action will display a counter that increments by one each press. We track the current count on the action's persisted
	 * settings using `setSettings` and `getSettings`.
	 */
	override async onKeyDown(ev: KeyDownEvent<SoundSwitchSettings>): Promise<void> {
		// Update the count from the settings.
		const { settings } = ev.payload;
		settings.incrementBy ??= 1;
		settings.count = (settings.count ?? 0) + settings.incrementBy;

		// Update the current count in the action's settings, and change the title.
		await ev.action.setSettings(settings);
		await ev.action.setTitle(`${settings.count}`);
	}

	override async onDialRotate(ev: DialRotateEvent<SoundSwitchSettings>): Promise<void> {
		const ticks = ev.payload.ticks;
		await this.cycleDeviceIndexForAction(ev.action, ticks > 0);
		this.updateDialLayout(ev.action);
	}

	override async onDialDown(ev: DialDownEvent<SoundSwitchSettings>): Promise<void> {
		const device = await this.getCurDeviceForAction(ev.action);
		if(device) {
			const res = await this.execAwait(`audioSwitcherUtil\\AppAudioSwitcherUtility.exe --set appDevice --process ${this.processInfo?.processId} --device ${device.Id}`);
			if(res.error) {
				streamDeck.logger.error(res.error);
			}
		}
	}

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<SoundSwitchSettings>): Promise<void> {
		const settings = await ev.action.getSettings<SoundSwitchSettings>();
		streamDeck.ui.sendToPropertyInspector({
				event: "getProducts",
				items: this.#getAvailableDevices(settings.showInactive),
			} satisfies DataSourcePayload);
	}

	/**
	 * Listen for messages from the property inspector.
	 * @param ev Event information.
	 */
	override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, SoundSwitchSettings>): Promise<void> {
		// Check if the payload is requesting a data source, i.e. the structure is { event: string }
		if (ev.payload instanceof Object && "event" in ev.payload && ev.payload.event === "getProducts") {
			const settings = await ev.action.getSettings<SoundSwitchSettings>();
			// Send the product ranges to the property inspector.
			streamDeck.ui.sendToPropertyInspector({
				event: "getProducts",
				items: this.#getAvailableDevices(settings.showInactive),
			} satisfies DataSourcePayload);
		}
	}

	#getAvailableDevices(showInactive: boolean): DataSourceResult {
		const devices = showInactive ? this.curDevices : this.curDevices.filter((d) => d.State & DeviceState.ACTIVE);
		let array = devices.map((device) => 
			({ 
				value: device.Id,
			 	label: showInactive ? `${device.Name} - ${DeviceState[device.State]}` : device.Name
			}))
		return array;
	}
}