import {
	actuatorCCs,
	CommandClasses,
	indexDBsByNode,
	isRecoverableZWaveError,
	isTransmissionError,
	isZWaveError,
	NODE_ID_BROADCAST,
	ValueDB,
	ZWaveError,
	ZWaveErrorCodes,
} from "@zwave-js/core";
import { flatMap, JSONObject, num2hex } from "@zwave-js/shared";
import { distinct } from "alcalzone-shared/arrays";
import {
	createDeferredPromise,
	DeferredPromise,
} from "alcalzone-shared/deferred-promise";
import { composeObject } from "alcalzone-shared/objects";
import { isObject } from "alcalzone-shared/typeguards";
import { EventEmitter } from "events";
import type { AssociationCC } from "../commandclass/AssociationCC";
import type {
	AssociationGroup,
	AssociationGroupInfoCC,
} from "../commandclass/AssociationGroupInfoCC";
import {
	getManufacturerIdValueId,
	getManufacturerIdValueMetadata,
	getProductIdValueId,
	getProductIdValueMetadata,
	getProductTypeValueId,
	getProductTypeValueMetadata,
} from "../commandclass/ManufacturerSpecificCC";
import type {
	Association,
	EndpointAddress,
	MultiChannelAssociationCC,
} from "../commandclass/MultiChannelAssociationCC";
import type { Driver, RequestHandler } from "../driver/Driver";
import { FunctionType } from "../message/Constants";
import type { Message } from "../message/Message";
import type { SuccessIndicator } from "../message/SuccessIndicator";
import { DeviceClass } from "../node/DeviceClass";
import { ZWaveNode } from "../node/Node";
import { InterviewStage, NodeStatus } from "../node/Types";
import { VirtualNode } from "../node/VirtualNode";
import {
	AddNodeStatus,
	AddNodeToNetworkRequest,
	AddNodeType,
} from "./AddNodeToNetworkRequest";
import { AssignReturnRouteRequest } from "./AssignReturnRouteMessages";
import { AssignSUCReturnRouteRequest } from "./AssignSUCReturnRouteMessages";
import { DeleteReturnRouteRequest } from "./DeleteReturnRouteMessages";
import { DeleteSUCReturnRouteRequest } from "./DeleteSUCReturnRouteMessages";
import {
	GetControllerCapabilitiesRequest,
	GetControllerCapabilitiesResponse,
} from "./GetControllerCapabilitiesMessages";
import {
	GetControllerIdRequest,
	GetControllerIdResponse,
} from "./GetControllerIdMessages";
import {
	GetControllerVersionRequest,
	GetControllerVersionResponse,
} from "./GetControllerVersionMessages";
import { GetRoutingInfoRequest } from "./GetRoutingInfoMessages";
import {
	GetSerialApiCapabilitiesRequest,
	GetSerialApiCapabilitiesResponse,
} from "./GetSerialApiCapabilitiesMessages";
import {
	GetSerialApiInitDataRequest,
	GetSerialApiInitDataResponse,
} from "./GetSerialApiInitDataMessages";
import {
	GetSUCNodeIdRequest,
	GetSUCNodeIdResponse,
} from "./GetSUCNodeIdMessages";
import { HardResetRequest } from "./HardResetRequest";
import {
	IsFailedNodeRequest,
	IsFailedNodeResponse,
} from "./IsFailedNodeMessages";
import {
	RemoveFailedNodeRequest,
	RemoveFailedNodeRequestStatusReport,
	RemoveFailedNodeResponse,
	RemoveFailedNodeStartFlags,
	RemoveFailedNodeStatus,
} from "./RemoveFailedNodeMessages";
import {
	RemoveNodeFromNetworkRequest,
	RemoveNodeStatus,
	RemoveNodeType,
} from "./RemoveNodeFromNetworkRequest";
import {
	ReplaceFailedNodeRequest,
	ReplaceFailedNodeRequestStatusReport,
	ReplaceFailedNodeResponse,
	ReplaceFailedNodeStartFlags,
	ReplaceFailedNodeStatus,
} from "./ReplaceFailedNodeRequest";
import {
	NodeNeighborUpdateStatus,
	RequestNodeNeighborUpdateReport,
	RequestNodeNeighborUpdateRequest,
} from "./RequestNodeNeighborUpdateMessages";
import {
	SetSerialApiTimeoutsRequest,
	SetSerialApiTimeoutsResponse,
} from "./SetSerialApiTimeoutsMessages";
import { SetSUCNodeIdRequest } from "./SetSUCNodeIDMessages";
import { ZWaveLibraryTypes } from "./ZWaveLibraryTypes";

export type HealNodeStatus = "pending" | "done" | "failed" | "skipped";

export type ThrowingMap<K, V> = Map<K, V> & { getOrThrow(key: K): V };
export type ReadonlyThrowingMap<K, V> = ReadonlyMap<K, V> & {
	getOrThrow(key: K): V;
};

// Strongly type the event emitter events
interface ControllerEventCallbacks {
	"inclusion failed": () => void;
	"exclusion failed": () => void;
	"inclusion started": (secure: boolean) => void;
	"exclusion started": () => void;
	"inclusion stopped": () => void;
	"exclusion stopped": () => void;
	"node added": (node: ZWaveNode) => void;
	"node removed": (node: ZWaveNode, replaced: boolean) => void;
	"heal network progress": (
		progress: ReadonlyMap<number, HealNodeStatus>,
	) => void;
	"heal network done": (result: ReadonlyMap<number, HealNodeStatus>) => void;
}

export type ControllerEvents = Extract<keyof ControllerEventCallbacks, string>;

export interface ZWaveController {
	on<TEvent extends ControllerEvents>(
		event: TEvent,
		callback: ControllerEventCallbacks[TEvent],
	): this;
	once<TEvent extends ControllerEvents>(
		event: TEvent,
		callback: ControllerEventCallbacks[TEvent],
	): this;
	removeListener<TEvent extends ControllerEvents>(
		event: TEvent,
		callback: ControllerEventCallbacks[TEvent],
	): this;
	off<TEvent extends ControllerEvents>(
		event: TEvent,
		callback: ControllerEventCallbacks[TEvent],
	): this;
	removeAllListeners(event?: ControllerEvents): this;

	emit<TEvent extends ControllerEvents>(
		event: TEvent,
		...args: Parameters<ControllerEventCallbacks[TEvent]>
	): boolean;
}

export class ZWaveController extends EventEmitter {
	/** @internal */
	public constructor(private readonly driver: Driver) {
		super();

		this._nodes = new Map<number, ZWaveNode>() as ThrowingMap<
			number,
			ZWaveNode
		>;
		this._nodes.getOrThrow = function (
			this: Map<number, ZWaveNode>,
			nodeId: number,
		) {
			const node = this.get(nodeId);
			if (!node) {
				throw new ZWaveError(
					`Node ${nodeId} was not found!`,
					ZWaveErrorCodes.Controller_NodeNotFound,
				);
			}
			return node;
		}.bind(this._nodes);

		// register message handlers
		driver.registerRequestHandler(
			FunctionType.AddNodeToNetwork,
			this.handleAddNodeRequest.bind(this),
		);
		driver.registerRequestHandler(
			FunctionType.RemoveNodeFromNetwork,
			this.handleRemoveNodeRequest.bind(this),
		);
		driver.registerRequestHandler(
			FunctionType.ReplaceFailedNode,
			this.handleReplaceNodeRequest.bind(this),
		);
	}

	private _libraryVersion: string | undefined;
	public get libraryVersion(): string | undefined {
		return this._libraryVersion;
	}

	private _type: ZWaveLibraryTypes | undefined;
	public get type(): ZWaveLibraryTypes | undefined {
		return this._type;
	}

	private _homeId: number | undefined;
	/** A 32bit number identifying the current network */
	public get homeId(): number | undefined {
		return this._homeId;
	}

	private _ownNodeId: number | undefined;
	/** The ID of the controller in the current network */
	public get ownNodeId(): number | undefined {
		return this._ownNodeId;
	}

	private _isSecondary: boolean | undefined;
	public get isSecondary(): boolean | undefined {
		return this._isSecondary;
	}

	private _isUsingHomeIdFromOtherNetwork: boolean | undefined;
	public get isUsingHomeIdFromOtherNetwork(): boolean | undefined {
		return this._isUsingHomeIdFromOtherNetwork;
	}

	private _isSISPresent: boolean | undefined;
	public get isSISPresent(): boolean | undefined {
		return this._isSISPresent;
	}

	private _wasRealPrimary: boolean | undefined;
	public get wasRealPrimary(): boolean | undefined {
		return this._wasRealPrimary;
	}

	private _isStaticUpdateController: boolean | undefined;
	public get isStaticUpdateController(): boolean | undefined {
		return this._isStaticUpdateController;
	}

	private _isSlave: boolean | undefined;
	public get isSlave(): boolean | undefined {
		return this._isSlave;
	}

	private _serialApiVersion: string | undefined;
	public get serialApiVersion(): string | undefined {
		return this._serialApiVersion;
	}

	private _manufacturerId: number | undefined;
	public get manufacturerId(): number | undefined {
		return this._manufacturerId;
	}

	private _productType: number | undefined;
	public get productType(): number | undefined {
		return this._productType;
	}

	private _productId: number | undefined;
	public get productId(): number | undefined {
		return this._productId;
	}

	private _supportedFunctionTypes: FunctionType[] | undefined;
	public get supportedFunctionTypes(): readonly FunctionType[] | undefined {
		return this._supportedFunctionTypes;
	}

	/** Checks if a given Z-Wave function type is supported by this controller */
	public isFunctionSupported(functionType: FunctionType): boolean {
		if (this._supportedFunctionTypes == null) {
			throw new ZWaveError(
				"Cannot check yet if a function is supported by the controller. The interview process has not been completed.",
				ZWaveErrorCodes.Driver_NotReady,
			);
		}
		return this._supportedFunctionTypes.indexOf(functionType) > -1;
	}

	private _sucNodeId: number | undefined;
	public get sucNodeId(): number | undefined {
		return this._sucNodeId;
	}

	private _supportsTimers: boolean | undefined;
	public get supportsTimers(): boolean | undefined {
		return this._supportsTimers;
	}

	private _nodes: ThrowingMap<number, ZWaveNode>;
	/** A dictionary of the nodes connected to this controller */
	public get nodes(): ReadonlyThrowingMap<number, ZWaveNode> {
		return this._nodes;
	}

	/** Returns a reference to the (virtual) broadcast node, which allows sending commands to all nodes */
	public getBroadcastNode(): VirtualNode {
		return new VirtualNode(
			NODE_ID_BROADCAST,
			this.driver,
			this.nodes.values(),
		);
	}

	/** Creates a virtual node that can be used to send multicast commands to several nodes */
	public getMulticastGroup(nodeIDs: number[]): VirtualNode {
		return new VirtualNode(
			undefined,
			this.driver,
			nodeIDs.map((id) => this._nodes.get(id)!),
		);
	}

	/**
	 * @internal
	 * Interviews the controller for the necessary information.
	 * @param initValueDBs Asynchronous callback for the driver to initialize the Value DBs before nodes are created
	 * @param restoreFromCache Asynchronous callback for the driver to restore the network from cache after nodes are created
	 */
	public async interview(
		initValueDBs: () => Promise<void>,
		restoreFromCache: () => Promise<void>,
	): Promise<void> {
		this.driver.controllerLog.print("beginning interview...");

		// get basic controller version info
		this.driver.controllerLog.print(`querying version info...`);
		const version = await this.driver.sendMessage<GetControllerVersionResponse>(
			new GetControllerVersionRequest(this.driver),
			{
				supportCheck: false,
			},
		);
		this._libraryVersion = version.libraryVersion;
		this._type = version.controllerType;
		this.driver.controllerLog.print(
			`received version info:
  controller type: ${ZWaveLibraryTypes[this._type]}
  library version: ${this._libraryVersion}`,
		);

		// get the home and node id of the controller
		this.driver.controllerLog.print(`querying controller IDs...`);
		const ids = await this.driver.sendMessage<GetControllerIdResponse>(
			new GetControllerIdRequest(this.driver),
			{ supportCheck: false },
		);
		this._homeId = ids.homeId;
		this._ownNodeId = ids.ownNodeId;
		this.driver.controllerLog.print(
			`received controller IDs:
  home ID:     ${num2hex(this._homeId)}
  own node ID: ${this._ownNodeId}`,
		);

		// find out what the controller can do
		this.driver.controllerLog.print(`querying controller capabilities...`);
		const ctrlCaps = await this.driver.sendMessage<GetControllerCapabilitiesResponse>(
			new GetControllerCapabilitiesRequest(this.driver),
			{
				supportCheck: false,
			},
		);
		this._isSecondary = ctrlCaps.isSecondary;
		this._isUsingHomeIdFromOtherNetwork =
			ctrlCaps.isUsingHomeIdFromOtherNetwork;
		this._isSISPresent = ctrlCaps.isSISPresent;
		this._wasRealPrimary = ctrlCaps.wasRealPrimary;
		this._isStaticUpdateController = ctrlCaps.isStaticUpdateController;
		this.driver.controllerLog.print(
			`received controller capabilities:
  controller role:     ${this._isSecondary ? "secondary" : "primary"}
  is in other network: ${this._isUsingHomeIdFromOtherNetwork}
  is SIS present:      ${this._isSISPresent}
  was real primary:    ${this._wasRealPrimary}
  is a SUC:            ${this._isStaticUpdateController}`,
		);

		// find out which part of the API is supported
		this.driver.controllerLog.print(`querying API capabilities...`);
		const apiCaps = await this.driver.sendMessage<GetSerialApiCapabilitiesResponse>(
			new GetSerialApiCapabilitiesRequest(this.driver),
			{
				supportCheck: false,
			},
		);
		this._serialApiVersion = apiCaps.serialApiVersion;
		this._manufacturerId = apiCaps.manufacturerId;
		this._productType = apiCaps.productType;
		this._productId = apiCaps.productId;
		this._supportedFunctionTypes = apiCaps.supportedFunctionTypes;
		this.driver.controllerLog.print(
			`received API capabilities:
  serial API version:  ${this._serialApiVersion}
  manufacturer ID:     ${num2hex(this._manufacturerId)}
  product type:        ${num2hex(this._productType)}
  product ID:          ${num2hex(this._productId)}
  supported functions: ${this._supportedFunctionTypes
		.map((fn) => `\n  · ${FunctionType[fn]} (${num2hex(fn)})`)
		.join("")}`,
		);

		// now we can check if a function is supported

		// find the SUC
		this.driver.controllerLog.print(`finding SUC...`);
		const suc = await this.driver.sendMessage<GetSUCNodeIdResponse>(
			new GetSUCNodeIdRequest(this.driver),
			{ supportCheck: false },
		);
		this._sucNodeId = suc.sucNodeId;
		if (this._sucNodeId === 0) {
			this.driver.controllerLog.print(`No SUC present in the network`);
		} else if (this._sucNodeId === this._ownNodeId) {
			this.driver.controllerLog.print(`This is the SUC`);
		} else {
			this.driver.controllerLog.print(
				`SUC has node ID ${this.sucNodeId}`,
			);
		}

		// There needs to be a SUC/SIS in the network. If not, we promote ourselves to one if the following conditions are met:
		// We are the primary controller, but we are not SUC, there is no SUC and there is no SIS
		if (
			!this._isSecondary &&
			this._sucNodeId === 0 &&
			!this._isStaticUpdateController &&
			!this._isSISPresent
		) {
			this.driver.controllerLog.print(
				`There is no SUC/SIS in the network - promoting ourselves...`,
			);
			try {
				const result = await this.configureSUC(
					this._ownNodeId,
					true,
					true,
				);
				this.driver.controllerLog.print(
					`Promotion to SUC/SIS ${result ? "succeeded" : "failed"}.`,
					result ? undefined : "warn",
				);
			} catch (e) {
				this.driver.controllerLog.print(
					`Error while promoting to SUC/SIS: ${e.message}`,
					"error",
				);
			}
		}

		// if it's a bridge controller, request the virtual nodes
		if (
			this.type === ZWaveLibraryTypes["Bridge Controller"] &&
			this.isFunctionSupported(FunctionType.FUNC_ID_ZW_GET_VIRTUAL_NODES)
		) {
			// TODO: send FUNC_ID_ZW_GET_VIRTUAL_NODES message
		}

		// Give the Driver time to set up the value DBs
		await initValueDBs();

		// Request information about all nodes with the GetInitData message
		this.driver.controllerLog.print(`querying node information...`);
		const initData = await this.driver.sendMessage<GetSerialApiInitDataResponse>(
			new GetSerialApiInitDataRequest(this.driver),
		);
		// override the information we might already have
		this._isSecondary = initData.isSecondary;
		this._isStaticUpdateController = initData.isStaticUpdateController;
		// and remember the new info
		this._isSlave = initData.isSlave;
		this._supportsTimers = initData.supportsTimers;
		// ignore the initVersion, no clue what to do with it
		this.driver.controllerLog.print(
			`received node information:
  controller role:            ${this._isSecondary ? "secondary" : "primary"}
  controller is a SUC:        ${this._isStaticUpdateController}
  controller is a slave:      ${this._isSlave}
  controller supports timers: ${this._supportsTimers}
  nodes in the network:       ${initData.nodeIds.join(", ")}`,
		);

		// Index the value DB for optimal performance
		const valueDBIndexes = indexDBsByNode([
			this.driver.valueDB!,
			this.driver.metadataDB!,
		]);
		// create an empty entry in the nodes map so we can initialize them afterwards
		for (const nodeId of initData.nodeIds) {
			this._nodes.set(
				nodeId,
				new ZWaveNode(
					nodeId,
					this.driver,
					undefined,
					undefined,
					undefined,
					// Use the previously created index to avoid doing extra work when creating the value DB
					this.createValueDBForNode(
						nodeId,
						valueDBIndexes.get(nodeId),
					),
				),
			);
		}

		// Now try to deserialize all nodes from the cache
		await restoreFromCache();

		// Set manufacturer information for the controller node
		const controllerValueDB = this._nodes.get(this._ownNodeId)!.valueDB;
		controllerValueDB.setMetadata(
			getManufacturerIdValueId(),
			getManufacturerIdValueMetadata(),
		);
		controllerValueDB.setMetadata(
			getProductTypeValueId(),
			getProductTypeValueMetadata(),
		);
		controllerValueDB.setMetadata(
			getProductIdValueId(),
			getProductIdValueMetadata(),
		);
		controllerValueDB.setValue(
			getManufacturerIdValueId(),
			this._manufacturerId,
		);
		controllerValueDB.setValue(getProductTypeValueId(), this._productType);
		controllerValueDB.setValue(getProductIdValueId(), this._productId);

		if (
			this.type !== ZWaveLibraryTypes["Bridge Controller"] &&
			this.isFunctionSupported(FunctionType.SetSerialApiTimeouts)
		) {
			const { ack, byte } = this.driver.options.timeouts;
			this.driver.controllerLog.print(
				`setting serial API timeouts: ack = ${ack} ms, byte = ${byte} ms`,
			);
			const resp = await this.driver.sendMessage<SetSerialApiTimeoutsResponse>(
				new SetSerialApiTimeoutsRequest(this.driver, {
					ackTimeout: ack,
					byteTimeout: byte,
				}),
			);
			this.driver.controllerLog.print(
				`serial API timeouts overwritten. The old values were: ack = ${resp.oldAckTimeout} ms, byte = ${resp.oldByteTimeout} ms`,
			);
		}

		// TODO: Tell the Z-Wave stick what kind of application this is
		//   The Z-Wave Application Layer MUST use the \ref ApplicationNodeInformation
		//   function to generate the Node Information frame and to save information about
		//   node capabilities. All Z Wave application related fields of the Node Information
		//   structure MUST be initialized by this function.

		// Afterwards, a hard reset is required, so we need to move this into another method
		// if (
		// 	this.isFunctionSupported(
		// 		FunctionType.FUNC_ID_SERIAL_API_APPL_NODE_INFORMATION,
		// 	)
		// ) {
		// 	this.driver.controllerLog.print(`sending application info...`);

		// 	// TODO: Generate this list dynamically
		// 	// A list of all CCs the controller will respond to
		// 	const supportedCCs = [CommandClasses.Time];
		// 	// Turn the CCs into buffers and concat them
		// 	const supportedCCBuffer = Buffer.concat(
		// 		supportedCCs.map(cc =>
		// 			cc >= 0xf1
		// 				? // extended CC
		// 				  Buffer.from([cc >>> 8, cc & 0xff])
		// 				: // normal CC
		// 				  Buffer.from([cc]),
		// 		),
		// 	);

		// 	const appInfoMsg = new Message(this.driver, {
		// 		type: MessageType.Request,
		// 		functionType:
		// 			FunctionType.FUNC_ID_SERIAL_API_APPL_NODE_INFORMATION,
		// 		payload: Buffer.concat([
		// 			Buffer.from([
		// 				0x01, // APPLICATION_NODEINFO_LISTENING
		// 				GenericDeviceClasses["Static Controller"],
		// 				0x01, // specific static PC controller
		// 				supportedCCBuffer.length, // length of supported CC list
		// 			]),
		// 			// List of supported CCs
		// 			supportedCCBuffer,
		// 		]),
		// 	});
		// 	await this.driver.sendMessage(appInfoMsg, {
		// 		priority: MessagePriority.Controller,
		// 		supportCheck: false,
		// 	});
		// }

		this.driver.controllerLog.print("Interview completed");
	}

	private createValueDBForNode(nodeId: number, ownKeys?: Set<string>) {
		return new ValueDB(
			nodeId,
			this.driver.valueDB!,
			this.driver.metadataDB!,
			ownKeys,
		);
	}

	/**
	 * Performs a hard reset on the controller. This wipes out all configuration!
	 * Warning: The driver needs to re-interview the controller, so don't call this directly
	 * @internal
	 */
	public hardReset(): Promise<void> {
		this.driver.controllerLog.print("performing hard reset...");
		// wotan-disable-next-line async-function-assignability
		return new Promise(async (resolve, reject) => {
			// handle the incoming message
			const handler: RequestHandler = (_msg) => {
				this.driver.controllerLog.print(`  hard reset succeeded`);

				// Clean up
				this._nodes.forEach((node) => node.removeAllListeners());
				this._nodes.clear();

				resolve();
				return true;
			};
			this.driver.registerRequestHandler(
				FunctionType.HardReset,
				handler,
				true,
			);
			// begin the reset process
			try {
				await this.driver.sendMessage(
					new HardResetRequest(this.driver),
					{ supportCheck: false },
				);
			} catch (e) {
				// in any case unregister the handler
				this.driver.controllerLog.print(
					`  hard reset failed: ${e.message}`,
					"error",
				);
				this.driver.unregisterRequestHandler(
					FunctionType.HardReset,
					handler,
				);
				reject(e);
			}
		});
	}

	private _exclusionActive: boolean = false;
	private _inclusionActive: boolean = false;
	private _includeNonSecure: boolean = false;
	private _includeController: boolean = false;
	private _nodePendingInclusion: ZWaveNode | undefined;
	private _nodePendingExclusion: ZWaveNode | undefined;
	private _nodePendingReplace: ZWaveNode | undefined;
	// The following variables are to be used for inclusion AND exclusion
	private _beginInclusionPromise: DeferredPromise<boolean> | undefined;
	private _stopInclusionPromise: DeferredPromise<boolean> | undefined;
	private _replaceFailedPromise: DeferredPromise<boolean> | undefined;

	/**
	 * Starts the inclusion process of new nodes.
	 * Resolves to true when the process was started, and false if the inclusion was already active.
	 *
	 * @param includeNonSecure Whether the node should be included non-securely, even if it supports Security. By default, all nodes will be included securely if possible
	 */
	public async beginInclusion(
		includeNonSecure: boolean = false,
	): Promise<boolean> {
		// don't start it twice
		if (this._inclusionActive || this._exclusionActive) return false;
		this._inclusionActive = true;
		this._includeNonSecure = includeNonSecure;

		this.driver.controllerLog.print(`starting inclusion process...`);

		// create the promise we're going to return
		this._beginInclusionPromise = createDeferredPromise();

		// kick off the inclusion process
		await this.driver.sendMessage(
			new AddNodeToNetworkRequest(this.driver, {
				addNodeType: AddNodeType.Any,
				highPower: true,
				networkWide: true,
			}),
		);

		return this._beginInclusionPromise;
	}

	/** Is used internally to stop an active inclusion process without creating deadlocks */
	private async stopInclusionInternal(): Promise<void> {
		// don't stop it twice
		if (!this._inclusionActive) return;
		this._inclusionActive = false;

		this.driver.controllerLog.print(`stopping inclusion process...`);

		// create the promise we're going to return
		this._stopInclusionPromise = createDeferredPromise();

		// kick off the inclusion process
		await this.driver.sendMessage(
			new AddNodeToNetworkRequest(this.driver, {
				addNodeType: AddNodeType.Stop,
				highPower: true,
				networkWide: true,
			}),
		);

		// Don't await the promise or we create a deadlock
		void this._stopInclusionPromise.then(() => {
			this.driver.controllerLog.print(
				`the inclusion process was stopped`,
			);
			this.emit("inclusion stopped");
		});
	}

	/**
	 * Stops an active inclusion process. Resolves to true when the controller leaves inclusion mode,
	 * and false if the inclusion was not active.
	 */
	public async stopInclusion(): Promise<boolean> {
		// don't stop it twice
		if (!this._inclusionActive) return false;

		await this.stopInclusionInternal();

		return this._stopInclusionPromise!;
	}

	/**
	 * Starts the exclusion process of new nodes.
	 * Resolves to true when the process was started,
	 * and false if an inclusion or exclusion process was already active
	 */
	public async beginExclusion(): Promise<boolean> {
		// don't start it twice
		if (this._inclusionActive || this._exclusionActive) return false;
		this._exclusionActive = true;

		this.driver.controllerLog.print(`starting exclusion process...`);

		// create the promise we're going to return
		this._beginInclusionPromise = createDeferredPromise();

		// kick off the inclusion process
		await this.driver.sendMessage(
			new RemoveNodeFromNetworkRequest(this.driver, {
				removeNodeType: RemoveNodeType.Any,
				highPower: true,
				networkWide: true,
			}),
		);

		return this._beginInclusionPromise;
	}

	/** Is used internally to stop an active inclusion process without creating deadlocks */
	private async stopExclusionInternal(): Promise<void> {
		// don't stop it twice
		if (!this._exclusionActive) return;
		this._exclusionActive = false;

		this.driver.controllerLog.print(`stopping exclusion process...`);

		// create the promise we're going to return
		this._stopInclusionPromise = createDeferredPromise();

		// kick off the inclusion process
		await this.driver.sendMessage(
			new RemoveNodeFromNetworkRequest(this.driver, {
				removeNodeType: RemoveNodeType.Stop,
				highPower: true,
				networkWide: true,
			}),
		);

		void this._stopInclusionPromise.then(() => {
			this.driver.controllerLog.print(
				`the exclusion process was stopped`,
			);
			this.emit("exclusion stopped");
		});
	}

	private async secureBootstrapS0(
		node: ZWaveNode,
		assumeSecure: boolean = false,
	): Promise<void> {
		// If security has been set up and we are allowed to include the node securely, try to do it
		if (
			this.driver.securityManager &&
			(assumeSecure || node.supportsCC(CommandClasses.Security))
		) {
			// Only try once, otherwise the node stays unsecure
			try {
				// When replacing a node, we receive no NIF, so we cannot know that the Security CC is supported.
				// Querying the node info however kicks some devices out of secure inclusion mode.
				// Therefore we must assume that the node supports Security in order to support replacing a node securely
				if (assumeSecure && !node.supportsCC(CommandClasses.Security)) {
					node.addCC(CommandClasses.Security, {
						secure: true,
						isSupported: true,
						version: 1,
					});
				}

				// SDS13783 - impose a 10s timeout on each message
				const api = node.commandClasses.Security.withOptions({
					expire: 10000,
				});
				// Request security scheme, because it is required by the specs
				await api.getSecurityScheme(); // ignore the result

				// Request nonce separately, so we can impose a timeout
				await api.getNonce({
					standalone: true,
					storeAsFreeNonce: true,
				});

				// send the network key
				await api.setNetworkKey(this.driver.securityManager.networkKey);

				if (this._includeController) {
					// Tell the controller which security scheme to use
					await api.inheritSecurityScheme();
				}

				// Remember that the node is secure
				node.isSecure = true;
			} catch (e: unknown) {
				let errorMessage = `Security bootstrapping failed, the node is included insecurely`;
				if (!isZWaveError(e)) {
					errorMessage += `: ${e as any}`;
				} else if (
					e.code === ZWaveErrorCodes.Controller_MessageExpired
				) {
					errorMessage += ": a secure inclusion timer has elapsed.";
				} else if (
					e.code !== ZWaveErrorCodes.Controller_MessageDropped &&
					e.code !== ZWaveErrorCodes.Controller_NodeTimeout
				) {
					errorMessage += `: ${e.message}`;
				}
				this.driver.controllerLog.logNode(
					node.id,
					errorMessage,
					"warn",
				);
				// Remember that the node is non-secure
				node.isSecure = false;
				node.removeCC(CommandClasses.Security);
			}
		} else {
			// Remember that the node is non-secure
			node.isSecure = false;
		}
	}

	/** Ensures that the node knows where to reach the controller */
	private async bootstrapLifelineAndWakeup(node: ZWaveNode): Promise<void> {
		if (node.supportsCC(CommandClasses["Z-Wave Plus Info"])) {
			// SDS11846: The Z-Wave+ lifeline must be assigned to a node as the very first thing
			if (
				node.supportsCC(CommandClasses.Association) ||
				node.supportsCC(CommandClasses["Multi Channel Association"])
			) {
				this.driver.controllerLog.logNode(node.id, {
					message: `Configuring Z-Wave+ Lifeline association...`,
					direction: "none",
				});
				const ownNodeId = this.driver.controller.ownNodeId!;

				try {
					if (node.supportsCC(CommandClasses.Association)) {
						await node.commandClasses.Association.addNodeIds(
							1,
							ownNodeId,
						);
					} else {
						await node.commandClasses[
							"Multi Channel Association"
						].addDestinations({
							groupId: 1,
							endpoints: [{ nodeId: ownNodeId, endpoint: 0 }],
						});
					}

					// After setting the association, make sure the node knows how to reach us
					await this.assignReturnRoute(node.id, ownNodeId);
				} catch (e: unknown) {
					if (isTransmissionError(e) || isRecoverableZWaveError(e)) {
						this.driver.controllerLog.logNode(node.id, {
							message: `Failed to configure Z-Wave+ Lifeline association: ${e.message}`,
							direction: "none",
							level: "warn",
						});
					} else {
						throw e;
					}
				}
			} else {
				this.driver.controllerLog.logNode(node.id, {
					message: `Cannot configure Z-Wave+ Lifeline association: Node does not support associations...`,
					direction: "none",
					level: "warn",
				});
			}
		}

		if (node.supportsCC(CommandClasses["Wake Up"])) {
			try {
				// Query the version, so we can setup the wakeup destination correctly.
				let supportedVersion: number | undefined;
				if (node.supportsCC(CommandClasses.Version)) {
					supportedVersion = await node.commandClasses.Version.getCCVersion(
						CommandClasses["Wake Up"],
					);
				}
				// If querying the version can't be done, we should at least assume that it supports V1
				supportedVersion ??= 1;
				if (supportedVersion > 0) {
					node.addCC(CommandClasses["Wake Up"], {
						version: supportedVersion,
					});
					const instance = node.createCCInstance(
						CommandClasses["Wake Up"],
					)!;
					await instance.interview();
				}
			} catch (e: unknown) {
				if (isTransmissionError(e) || isRecoverableZWaveError(e)) {
					this.driver.controllerLog.logNode(node.id, {
						message: `Cannot configure wakeup destination: ${e.message}`,
						direction: "none",
						level: "warn",
					});
				} else {
					// we want to pass all other errors through
					throw e;
				}
			}
		}
	}

	/**
	 * Stops an active exclusion process. Resolves to true when the controller leaves exclusion mode,
	 * and false if the inclusion was not active.
	 */
	public async stopExclusion(): Promise<boolean> {
		// don't stop it twice
		if (!this._exclusionActive) return false;

		await this.stopExclusionInternal();

		return this._stopInclusionPromise!;
	}

	/**
	 * Is called when an AddNode request is received from the controller.
	 * Handles and controls the inclusion process.
	 */
	private async handleAddNodeRequest(
		msg: AddNodeToNetworkRequest,
	): Promise<boolean> {
		this.driver.controllerLog.print(
			`handling add node request (status = ${
				AddNodeStatus[msg.status!]
			})`,
		);
		if (!this._inclusionActive && msg.status !== AddNodeStatus.Done) {
			this.driver.controllerLog.print(
				`  inclusion is NOT active, ignoring it...`,
			);
			return true; // Don't invoke any more handlers
		}

		switch (msg.status) {
			case AddNodeStatus.Ready:
				// this is called when inclusion was started successfully
				this.driver.controllerLog.print(
					`  the controller is now ready to add nodes`,
				);
				if (this._beginInclusionPromise != null) {
					this._beginInclusionPromise.resolve(true);
					this.emit("inclusion started", !this._includeNonSecure);
				}
				break;
			case AddNodeStatus.Failed:
				// this is called when inclusion could not be started...
				if (this._beginInclusionPromise != null) {
					this.driver.controllerLog.print(
						`  starting the inclusion failed`,
						"error",
					);
					this._beginInclusionPromise.reject(
						new ZWaveError(
							"The inclusion could not be started.",
							ZWaveErrorCodes.Controller_InclusionFailed,
						),
					);
				} else {
					// ...or adding a node failed
					this.driver.controllerLog.print(
						`  adding the node failed`,
						"error",
					);
					this.emit("inclusion failed");
				}
				// in any case, stop the inclusion process so we don't accidentally add another node
				try {
					await this.stopInclusionInternal();
				} catch {
					/* ok */
				}
				break;
			case AddNodeStatus.AddingController:
				this._includeController = true;
			// fall through!
			case AddNodeStatus.AddingSlave: {
				// this is called when a new node is added
				this._nodePendingInclusion = new ZWaveNode(
					msg.statusContext!.nodeId,
					this.driver,
					new DeviceClass(
						this.driver.configManager,
						msg.statusContext!.basic!,
						msg.statusContext!.generic!,
						msg.statusContext!.specific!,
					),
					msg.statusContext!.supportedCCs,
					msg.statusContext!.controlledCCs,
					// Create an empty value DB and specify that it contains no values
					// to avoid indexing the existing values
					this.createValueDBForNode(
						msg.statusContext!.nodeId,
						new Set(),
					),
				);
				// TODO: According to INS13954, there are several more steps and different timeouts when including a controller
				// For now do the absolute minimum - that is include the controller
				return true; // Don't invoke any more handlers
			}
			case AddNodeStatus.ProtocolDone: {
				// this is called after a new node is added
				// stop the inclusion process so we don't accidentally add another node
				try {
					await this.stopInclusionInternal();
				} catch {
					/* ok */
				}
				break;
			}
			case AddNodeStatus.Done: {
				// this is called when the inclusion was completed
				this.driver.controllerLog.print(
					`done called for ${msg.statusContext!.nodeId}`,
				);
				// stopping the inclusion was acknowledged by the controller
				if (this._stopInclusionPromise != null)
					this._stopInclusionPromise.resolve(true);

				if (msg.statusContext!.nodeId === NODE_ID_BROADCAST) {
					// No idea how this can happen but it dit at least once
					this.driver.controllerLog.print(
						`Cannot add a node with the Node ID ${NODE_ID_BROADCAST}, aborting...`,
						"warn",
					);
					this._nodePendingInclusion = undefined;
				} else if (this._nodePendingInclusion != null) {
					const newNode = this._nodePendingInclusion;
					const supportedCommandClasses = [
						...newNode.implementedCommandClasses.entries(),
					]
						.filter(([, info]) => info.isSupported)
						.map(([cc]) => cc);
					const controlledCommandClasses = [
						...newNode.implementedCommandClasses.entries(),
					]
						.filter(([, info]) => info.isControlled)
						.map(([cc]) => cc);
					this.driver.controllerLog.print(
						`finished adding node ${newNode.id}:
  basic device class:    ${newNode.deviceClass?.basic.label}
  generic device class:  ${newNode.deviceClass?.generic.label}
  specific device class: ${newNode.deviceClass?.specific.label}
  supported CCs: ${supportedCommandClasses
		.map((cc) => `\n  · ${CommandClasses[cc]} (${num2hex(cc)})`)
		.join("")}
  controlled CCs: ${controlledCommandClasses
		.map((cc) => `\n  · ${CommandClasses[cc]} (${num2hex(cc)})`)
		.join("")}`,
					);
					// remember the node
					this._nodes.set(newNode.id, newNode);
					this._nodePendingInclusion = undefined;

					// We're communicating with the device, so assume it is alive
					// If it is actually a sleeping device, it will be marked as such later
					newNode.markAsAlive();

					// Assign SUC return route to make sure the node knows where to get its routes from
					newNode.hasSUCReturnRoute = await this.assignSUCReturnRoute(
						newNode.id,
					);

					if (!this._includeNonSecure) {
						await this.secureBootstrapS0(newNode);
					}
					this._includeController = false;

					// Bootstrap the node's lifelines, so it knows where the controller is
					await this.bootstrapLifelineAndWakeup(newNode);

					// We're done adding this node, notify listeners
					this.emit("node added", newNode);
				}
				break;
			}
			default:
				// not sure what to do with this message
				return false;
		}
		return true; // Don't invoke any more handlers
	}

	/**
	 * Is called when an ReplaceFailed request is received from the controller.
	 * Handles and controls the replace process.
	 */
	private async handleReplaceNodeRequest(
		msg: ReplaceFailedNodeRequestStatusReport,
	): Promise<boolean> {
		this.driver.controllerLog.print(
			`handling replace node request (status = ${
				ReplaceFailedNodeStatus[msg.replaceStatus]
			})`,
		);

		switch (msg.replaceStatus) {
			case ReplaceFailedNodeStatus.NodeOK:
				this._replaceFailedPromise?.reject(
					new ZWaveError(
						`The node could not be replaced because it has responded`,
						ZWaveErrorCodes.ReplaceFailedNode_NodeOK,
					),
				);
				break;
			case ReplaceFailedNodeStatus.FailedNodeReplaceFailed:
				this._replaceFailedPromise?.reject(
					new ZWaveError(
						`The failed node has not been replaced`,
						ZWaveErrorCodes.ReplaceFailedNode_Failed,
					),
				);
				break;
			case ReplaceFailedNodeStatus.FailedNodeReplace:
				// failed node is now ready to be replaced and controller is ready to add a new
				// node with the nodeID of the failed node
				this.driver.controllerLog.print(
					`The failed node is ready to be replaced, inclusion started...`,
				);
				this.emit("inclusion started", !this._includeNonSecure);
				this._inclusionActive = true;
				this._replaceFailedPromise?.resolve(true);

				// stop here, don't emit inclusion failed
				return true;
			case ReplaceFailedNodeStatus.FailedNodeReplaceDone:
				this.driver.controllerLog.print(`The failed node was replaced`);
				this.emit("inclusion stopped");

				if (this._nodePendingReplace) {
					this.emit("node removed", this._nodePendingReplace, true);
					this._nodes.delete(this._nodePendingReplace.id);

					// Create a fresh node instance and forget the old one
					const newNode = new ZWaveNode(
						this._nodePendingReplace.id,
						this.driver,
						undefined,
						undefined,
						undefined,
						// Create an empty value DB and specify that it contains no values
						// to avoid indexing the existing values
						this.createValueDBForNode(
							this._nodePendingReplace.id,
							new Set(),
						),
					);
					this._nodePendingReplace = undefined;
					this._nodes.set(newNode.id, newNode);

					// We're communicating with the device, so assume it is alive
					// If it is actually a sleeping device, it will be marked as such later
					newNode.markAsAlive();

					// Assign SUC return route to make sure the node knows where to get its routes from
					newNode.hasSUCReturnRoute = await this.assignSUCReturnRoute(
						newNode.id,
					);

					// Try perform the security bootstrap process
					if (!this._includeNonSecure) {
						await this.secureBootstrapS0(newNode, true);
					}

					// Bootstrap the node's lifelines, so it knows where the controller is
					await this.bootstrapLifelineAndWakeup(newNode);

					// We're done adding this node, notify listeners. This also kicks off the node interview
					this.emit("node added", newNode);
				}

				// stop here, don't emit inclusion failed
				return true;
		}

		this.emit("inclusion failed");

		return false; // Don't invoke any more handlers
	}

	/**
	 * Is called when a RemoveNode request is received from the controller.
	 * Handles and controls the exclusion process.
	 */
	private async handleRemoveNodeRequest(
		msg: RemoveNodeFromNetworkRequest,
	): Promise<boolean> {
		this.driver.controllerLog.print(
			`handling remove node request (status = ${
				RemoveNodeStatus[msg.status!]
			})`,
		);
		if (!this._exclusionActive && msg.status !== RemoveNodeStatus.Done) {
			this.driver.controllerLog.print(
				`  exclusion is NOT active, ignoring it...`,
			);
			return true; // Don't invoke any more handlers
		}

		switch (msg.status) {
			case RemoveNodeStatus.Ready:
				// this is called when inclusion was started successfully
				this.driver.controllerLog.print(
					`  the controller is now ready to remove nodes`,
				);
				if (this._beginInclusionPromise != null) {
					this._beginInclusionPromise.resolve(true);
					this.emit("exclusion started");
				}
				break;

			case RemoveNodeStatus.Failed:
				// this is called when inclusion could not be started...
				if (this._beginInclusionPromise != null) {
					this.driver.controllerLog.print(
						`  starting the exclusion failed`,
						"error",
					);
					this._beginInclusionPromise.reject(
						new ZWaveError(
							"The exclusion could not be started.",
							ZWaveErrorCodes.Controller_ExclusionFailed,
						),
					);
				} else {
					// ...or removing a node failed
					this.driver.controllerLog.print(
						`  removing the node failed`,
						"error",
					);
					this.emit("exclusion failed");
				}
				// in any case, stop the exclusion process so we don't accidentally remove another node
				try {
					await this.stopExclusionInternal();
				} catch {
					/* ok */
				}
				break;

			case RemoveNodeStatus.RemovingSlave:
			case RemoveNodeStatus.RemovingController: {
				// this is called when a node is removed
				this._nodePendingExclusion = this.nodes.get(
					msg.statusContext!.nodeId,
				);
				return true; // Don't invoke any more handlers
			}

			case RemoveNodeStatus.Done: {
				// this is called when the exclusion was completed
				// stop the exclusion process so we don't accidentally remove another node
				try {
					await this.stopExclusionInternal();
				} catch {
					/* ok */
				}

				// stopping the inclusion was acknowledged by the controller
				if (this._stopInclusionPromise != null)
					this._stopInclusionPromise.resolve(true);

				if (this._nodePendingExclusion != null) {
					this.driver.controllerLog.print(
						`Node ${this._nodePendingExclusion.id} was removed`,
					);

					// notify listeners
					this.emit(
						"node removed",
						this._nodePendingExclusion,
						false,
					);
					// and forget the node
					this._nodes.delete(this._nodePendingExclusion.id);
					this._nodePendingExclusion = undefined;
				}
				break;
			}
			default:
				// not sure what to do with this message
				return false;
		}
		return true; // Don't invoke any more handlers
	}

	private _healNetworkActive: boolean = false;
	private _healNetworkProgress = new Map<number, HealNodeStatus>();

	/**
	 * Performs a healing process for all alive nodes in the network,
	 * requesting updated neighbor lists and assigning fresh routes to
	 * association targets.
	 */
	public beginHealingNetwork(): boolean {
		// Don't start the process twice
		if (this._healNetworkActive) return false;
		this._healNetworkActive = true;

		this.driver.controllerLog.print(`starting network heal...`);

		// Reset all nodes to "not healed"
		this._healNetworkProgress.clear();
		for (const [id, node] of this._nodes) {
			if (id === this._ownNodeId) continue;
			if (
				// The node is known to be dead
				node.status === NodeStatus.Dead ||
				// The node is assumed asleep but has never been interviewed.
				// It is most likely dead
				(node.status === NodeStatus.Asleep &&
					node.interviewStage === InterviewStage.ProtocolInfo)
			) {
				// Don't heal dead nodes
				this.driver.controllerLog.logNode(
					id,
					`Skipping heal because the node is not responding.`,
				);
				this._healNetworkProgress.set(id, "skipped");
			} else {
				this._healNetworkProgress.set(id, "pending");
			}
		}

		// Do the heal process in the background
		void (async () => {
			const tasks = [...this._healNetworkProgress]
				.filter(([, status]) => status === "pending")
				.map(async ([nodeId]) => {
					// await the heal process for each node and treat errors as a non-successful heal
					const result = await this.healNodeInternal(nodeId).catch(
						() => false,
					);
					if (!this._healNetworkActive) return;

					// Track the success in a map
					this._healNetworkProgress.set(
						nodeId,
						result ? "done" : "failed",
					);
					// Notify listeners about the progress
					this.emit(
						"heal network progress",
						new Map(this._healNetworkProgress),
					);
				});
			await Promise.all(tasks);
			// Only emit the done event when the process wasn't stopped in the meantime
			if (this._healNetworkActive) {
				this.emit(
					"heal network done",
					new Map(this._healNetworkProgress),
				);
			}
			// We're done!
			this._healNetworkActive = false;
		})();

		// And update the progress once at the start
		this.emit("heal network progress", new Map(this._healNetworkProgress));

		return true;
	}

	/**
	 * Stops an network healing process. Resolves false if the process was not active, true otherwise.
	 */
	public stopHealingNetwork(): boolean {
		// don't stop it twice
		if (!this._healNetworkActive) return false;
		this._healNetworkActive = false;

		this.driver.controllerLog.print(`stopping network heal...`);

		// Cancel all transactions that were created by the healing process
		this.driver.rejectTransactions(
			(t) =>
				t.message instanceof RequestNodeNeighborUpdateRequest ||
				t.message instanceof GetRoutingInfoRequest ||
				t.message instanceof DeleteReturnRouteRequest ||
				t.message instanceof AssignReturnRouteRequest,
		);

		return true;
	}

	/**
	 * Performs a healing process for a single alive node in the network,
	 * updating the neighbor list and assigning fresh routes to
	 * association targets.
	 *
	 * Returns `true` if the process succeeded, `false` otherwise.
	 */
	public async healNode(nodeId: number): Promise<boolean> {
		// Don't start the process twice
		if (this._healNetworkActive) return false;
		this._healNetworkActive = true;

		// Don't try to heal dead nodes
		const node = this.nodes.getOrThrow(nodeId);
		if (
			// The node is known to be dead
			node.status === NodeStatus.Dead ||
			// The node is assumed asleep but has never been interviewed.
			// It is most likely dead
			(node.status === NodeStatus.Asleep &&
				node.interviewStage === InterviewStage.ProtocolInfo)
		) {
			this.driver.controllerLog.logNode(
				nodeId,
				`Skipping heal because the node is not responding.`,
			);
			return false;
		}

		try {
			this.driver.controllerLog.logNode(nodeId, `Healing node...`);
			return await this.healNodeInternal(nodeId);
		} finally {
			this._healNetworkActive = false;
		}
	}

	private async healNodeInternal(nodeId: number): Promise<boolean> {
		// The healing process consists of four steps
		// Each step is tried up to 5 times before the healing process is considered failed
		const maxAttempts = 5;

		// 1. command the node to refresh its neighbor list
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			// If the process was stopped in the meantime, cancel
			if (!this._healNetworkActive) return false;

			this.driver.controllerLog.logNode(nodeId, {
				message: `refreshing neighbor list (attempt ${attempt})...`,
				direction: "outbound",
			});
			try {
				const resp = await this.driver.sendMessage<RequestNodeNeighborUpdateReport>(
					new RequestNodeNeighborUpdateRequest(this.driver, {
						nodeId,
					}),
				);
				if (resp.updateStatus === NodeNeighborUpdateStatus.UpdateDone) {
					this.driver.controllerLog.logNode(nodeId, {
						message: "neighbor list refreshed...",
						direction: "inbound",
					});
					// this step was successful, continue with the next
					break;
				} else {
					// UpdateFailed
					this.driver.controllerLog.logNode(nodeId, {
						message: "refreshing neighbor list failed...",
						direction: "inbound",
						level: "warn",
					});
				}
			} catch (e) {
				this.driver.controllerLog.logNode(
					nodeId,
					`refreshing neighbor list failed: ${e.message}`,
					"warn",
				);
			}
			if (attempt === maxAttempts) {
				this.driver.controllerLog.logNode(nodeId, {
					message: `failed to update the neighbor list after ${maxAttempts} attempts, healing failed`,
					level: "warn",
					direction: "none",
				});
				return false;
			}
		}

		// 2. retrieve the updated list
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			// If the process was stopped in the meantime, cancel
			if (!this._healNetworkActive) return false;

			this.driver.controllerLog.logNode(nodeId, {
				message: `retrieving updated neighbor list (attempt ${attempt})...`,
				direction: "outbound",
			});

			try {
				// Retrieve the updated list from the node
				await this.nodes.get(nodeId)!.queryNeighborsInternal();
				break;
			} catch (e) {
				this.driver.controllerLog.logNode(
					nodeId,
					`retrieving the updated neighbor list failed: ${e.message}`,
					"warn",
				);
			}
			if (attempt === maxAttempts) {
				this.driver.controllerLog.logNode(nodeId, {
					message: `failed to retrieve the updated neighbor list after ${maxAttempts} attempts, healing failed`,
					level: "warn",
					direction: "none",
				});
				return false;
			}
		}

		// 3. delete all return routes so we can assign new ones
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			this.driver.controllerLog.logNode(nodeId, {
				message: `deleting return routes (attempt ${attempt})...`,
				direction: "outbound",
			});

			try {
				await this.driver.sendMessage(
					new DeleteReturnRouteRequest(this.driver, { nodeId }),
				);
				// this step was successful, continue with the next
				break;
			} catch (e) {
				this.driver.controllerLog.logNode(
					nodeId,
					`deleting return routes failed: ${e.message}`,
					"warn",
				);
			}
			if (attempt === maxAttempts) {
				this.driver.controllerLog.logNode(nodeId, {
					message: `failed to delete return routes after ${maxAttempts} attempts, healing failed`,
					level: "warn",
					direction: "none",
				});
				return false;
			}
		}

		// 4. Assign up to 4 return routes for associations, one of which should be the controller
		let associatedNodes: number[] = [];
		const maxReturnRoutes = 4;
		try {
			associatedNodes = distinct(
				flatMap<number, Association[]>(
					[...(this.getAssociations(nodeId).values() as any)],
					(assocs: Association[]) => assocs.map((a) => a.nodeId),
				),
			).sort();
		} catch {
			/* ignore */
		}
		// Always include ourselves first
		if (!associatedNodes.includes(this._ownNodeId!)) {
			associatedNodes.unshift(this._ownNodeId!);
		}
		if (associatedNodes.length > maxReturnRoutes) {
			associatedNodes = associatedNodes.slice(0, maxReturnRoutes);
		}
		this.driver.controllerLog.logNode(nodeId, {
			message: `assigning return routes to the following nodes:
${associatedNodes.join(", ")}`,
			direction: "outbound",
		});
		for (const destinationNodeId of associatedNodes) {
			for (let attempt = 1; attempt <= maxAttempts; attempt++) {
				this.driver.controllerLog.logNode(nodeId, {
					message: `assigning return route to node ${destinationNodeId} (attempt ${attempt})...`,
					direction: "outbound",
				});

				try {
					await this.driver.sendMessage(
						new AssignReturnRouteRequest(this.driver, {
							nodeId,
							destinationNodeId,
						}),
					);
					// this step was successful, continue with the next
					break;
				} catch (e) {
					this.driver.controllerLog.logNode(
						nodeId,
						`assigning return route failed: ${e.message}`,
						"warn",
					);
				}
				if (attempt === maxAttempts) {
					this.driver.controllerLog.logNode(nodeId, {
						message: `failed to assign return route after ${maxAttempts} attempts, healing failed`,
						level: "warn",
						direction: "none",
					});
					return false;
				}
			}
		}

		return true;
	}

	/** Configures the given Node to be SUC/SIS or not */
	public async configureSUC(
		nodeId: number,
		enableSUC: boolean,
		enableSIS: boolean,
	): Promise<boolean> {
		const result = await this.driver.sendMessage<
			Message & SuccessIndicator
		>(
			new SetSUCNodeIdRequest(this.driver, {
				sucNodeId: nodeId,
				enableSUC,
				enableSIS,
			}),
		);

		return result.isOK();
	}

	public async assignSUCReturnRoute(nodeId: number): Promise<boolean> {
		this.driver.controllerLog.logNode(nodeId, {
			message: `Assigning SUC return route...`,
			direction: "outbound",
		});

		try {
			const result = await this.driver.sendMessage<
				Message & SuccessIndicator
			>(
				new AssignSUCReturnRouteRequest(this.driver, {
					nodeId,
				}),
			);

			return result.isOK();
		} catch (e) {
			this.driver.controllerLog.logNode(
				nodeId,
				`Assigning SUC return route failed: ${e.message}`,
				"error",
			);
			return false;
		}
	}

	public async deleteSUCReturnRoute(nodeId: number): Promise<boolean> {
		this.driver.controllerLog.logNode(nodeId, {
			message: `Deleting SUC return route...`,
			direction: "outbound",
		});

		try {
			const result = await this.driver.sendMessage<
				Message & SuccessIndicator
			>(
				new DeleteSUCReturnRouteRequest(this.driver, {
					nodeId,
				}),
			);

			return result.isOK();
		} catch (e) {
			this.driver.controllerLog.logNode(
				nodeId,
				`Deleting SUC return route failed: ${e.message}`,
				"error",
			);
			return false;
		}
	}

	public async assignReturnRoute(
		nodeId: number,
		destinationNodeId: number,
	): Promise<boolean> {
		this.driver.controllerLog.logNode(nodeId, {
			message: `Assigning return route to node ${destinationNodeId}...`,
			direction: "outbound",
		});

		try {
			const result = await this.driver.sendMessage<
				Message & SuccessIndicator
			>(
				new AssignReturnRouteRequest(this.driver, {
					nodeId,
					destinationNodeId,
				}),
			);

			return result.isOK();
		} catch (e) {
			this.driver.controllerLog.logNode(
				nodeId,
				`Assigning return route failed: ${e.message}`,
				"error",
			);
			return false;
		}
	}

	public async deleteReturnRoute(nodeId: number): Promise<boolean> {
		this.driver.controllerLog.logNode(nodeId, {
			message: `Deleting all return routes...`,
			direction: "outbound",
		});

		try {
			const result = await this.driver.sendMessage<
				Message & SuccessIndicator
			>(
				new DeleteReturnRouteRequest(this.driver, {
					nodeId,
				}),
			);

			return result.isOK();
		} catch (e) {
			this.driver.controllerLog.logNode(
				nodeId,
				`Deleting return routes failed: ${e.message}`,
				"error",
			);
			return false;
		}
	}

	/**
	 * Returns a dictionary of all association groups of this node and their information.
	 * This only works AFTER the interview process
	 */
	public getAssociationGroups(
		nodeId: number,
	): ReadonlyMap<number, AssociationGroup> {
		const node = this.nodes.getOrThrow(nodeId);

		// Check whether we have multi channel support or not
		let assocInstance: AssociationCC;
		let mcInstance: MultiChannelAssociationCC | undefined;
		if (node.supportsCC(CommandClasses.Association)) {
			assocInstance = node.createCCInstanceUnsafe<AssociationCC>(
				CommandClasses.Association,
			)!;
		} else {
			throw new ZWaveError(
				`Node ${nodeId} does not support associations!`,
				ZWaveErrorCodes.CC_NotSupported,
			);
		}
		if (node.supportsCC(CommandClasses["Multi Channel Association"])) {
			mcInstance = node.createCCInstanceUnsafe<MultiChannelAssociationCC>(
				CommandClasses["Multi Channel Association"],
			)!;
		}

		const assocGroupCount = assocInstance.getGroupCountCached() ?? 0;
		const mcGroupCount = mcInstance?.getGroupCountCached() ?? 0;
		const groupCount = Math.max(assocGroupCount, mcGroupCount);

		const ret = new Map<number, AssociationGroup>();

		if (node.supportsCC(CommandClasses["Association Group Information"])) {
			// We can read all information we need from the AGI CC
			const agiInstance = node.createCCInstance<AssociationGroupInfoCC>(
				CommandClasses["Association Group Information"],
			)!;
			for (let group = 1; group <= groupCount; group++) {
				const assocConfig = node.deviceConfig?.associations?.get(group);
				const multiChannel = !!mcInstance && group <= mcGroupCount;
				ret.set(group, {
					maxNodes:
						(multiChannel
							? mcInstance!
							: assocInstance
						).getMaxNodesCached(group) || 1,
					// AGI implies Z-Wave+ where group 1 is the lifeline
					isLifeline: group === 1,
					label:
						// prefer the configured label if we have one
						assocConfig?.label ??
						// the ones reported by AGI are sometimes pretty bad
						agiInstance.getGroupNameCached(group) ??
						// but still better than "unnamed"
						`Unnamed group ${group}`,
					multiChannel,
					profile: agiInstance.getGroupProfileCached(group),
					issuedCommands: agiInstance.getIssuedCommandsCached(group),
				});
			}
		} else {
			// we need to consult the device config
			for (let group = 1; group <= groupCount; group++) {
				const assocConfig = node.deviceConfig?.associations?.get(group);
				const multiChannel = !!mcInstance && group <= mcGroupCount;
				ret.set(group, {
					maxNodes:
						(multiChannel
							? mcInstance!
							: assocInstance
						).getMaxNodesCached(group) ||
						assocConfig?.maxNodes ||
						1,
					isLifeline: assocConfig?.isLifeline ?? group === 1,
					label: assocConfig?.label ?? `Unnamed group ${group}`,
					multiChannel,
				});
			}
		}
		return ret;
	}

	/** Returns all Associations (Multi Channel or normal) that are configured on a node */
	public getAssociations(
		nodeId: number,
	): ReadonlyMap<number, readonly Association[]> {
		const node = this.nodes.getOrThrow(nodeId);

		const ret = new Map<number, readonly Association[]>();

		if (node.supportsCC(CommandClasses.Association)) {
			const cc = node.createCCInstanceUnsafe<AssociationCC>(
				CommandClasses.Association,
			)!;
			const destinations = cc.getAllDestinationsCached();
			for (const [groupId, assocs] of destinations) {
				ret.set(groupId, assocs);
			}
		} else {
			throw new ZWaveError(
				`Node ${nodeId} does not support associations!`,
				ZWaveErrorCodes.CC_NotSupported,
			);
		}

		// Merge the "normal" destinations with multi channel destinations
		if (node.supportsCC(CommandClasses["Multi Channel Association"])) {
			const cc = node.createCCInstanceUnsafe<MultiChannelAssociationCC>(
				CommandClasses["Multi Channel Association"],
			)!;
			const destinations = cc.getAllDestinationsCached();
			for (const [groupId, assocs] of destinations) {
				if (ret.has(groupId)) {
					const normalAssociations = ret.get(groupId)!;
					ret.set(groupId, [
						...normalAssociations,
						// Eliminate potential duplicates
						...assocs.filter(
							(a1) =>
								normalAssociations.findIndex(
									(a2) =>
										a1.nodeId === a2.nodeId &&
										a1.endpoint === a2.endpoint,
								) === -1,
						),
					]);
				} else {
					ret.set(groupId, assocs);
				}
			}
		}

		return ret;
	}

	/** Checks if a given association is allowed */
	public isAssociationAllowed(
		nodeId: number,
		group: number,
		association: Association,
	): boolean {
		const node = this.nodes.getOrThrow(nodeId);
		const targetNode = this.nodes.getOrThrow(association.nodeId);

		// Check that the target endpoint exists except when adding an association to the controller
		const targetEndpoint =
			association.nodeId === this._ownNodeId
				? targetNode
				: targetNode.getEndpoint(association.endpoint ?? 0);
		if (!targetEndpoint) {
			throw new ZWaveError(
				`The endpoint ${association.endpoint} was not found on node ${association.nodeId}!`,
				ZWaveErrorCodes.Controller_EndpointNotFound,
			);
		}

		// SDS14223:
		// A controlling node MUST NOT associate Node A to a Node B destination that does not support
		// the Command Class that the Node A will be controlling
		//
		// To determine this, the node must support the AGI CC or we have no way of knowing which
		// CCs the node will control
		if (
			!node.supportsCC(CommandClasses.Association) &&
			!node.supportsCC(CommandClasses["Multi Channel Association"])
		) {
			throw new ZWaveError(
				`Node ${nodeId} does not support associations!`,
				ZWaveErrorCodes.CC_NotSupported,
			);
		} else if (
			!node.supportsCC(CommandClasses["Association Group Information"])
		) {
			return true;
		}

		// The following checks don't apply to Lifeline associations
		if (association.nodeId === this._ownNodeId) return true;

		const groupCommandList = node
			.createCCInstanceInternal<AssociationGroupInfoCC>(
				CommandClasses["Association Group Information"],
			)!
			.getIssuedCommandsCached(group);
		if (!groupCommandList || !groupCommandList.size) {
			// We don't know which CCs this group controls, just allow it
			return true;
		}
		const groupCCs = [...groupCommandList.keys()];

		// A controlling node MAY create an association to a destination supporting an
		// actuator Command Class if the actual association group sends Basic Control Command Class.
		if (
			groupCCs.includes(CommandClasses.Basic) &&
			actuatorCCs.some((cc) => targetEndpoint?.supportsCC(cc))
		) {
			return true;
		}

		// Enforce that at least one issued CC is supported
		return groupCCs.some((cc) => targetEndpoint?.supportsCC(cc));
	}

	/**
	 * Adds associations to a node
	 */
	public async addAssociations(
		nodeId: number,
		group: number,
		associations: Association[],
	): Promise<void> {
		const node = this.nodes.getOrThrow(nodeId);

		// Check whether we should add any associations the device does not have support for
		let assocInstance: AssociationCC | undefined;
		let mcInstance: MultiChannelAssociationCC | undefined;
		// Split associations into conventional and endpoint associations
		const nodeAssociations = distinct(
			associations
				.filter((a) => a.endpoint == undefined)
				.map((a) => a.nodeId),
		);
		const endpointAssociations = associations.filter(
			(a) => a.endpoint != undefined,
		) as EndpointAddress[];

		if (node.supportsCC(CommandClasses.Association)) {
			assocInstance = node.createCCInstanceUnsafe<AssociationCC>(
				CommandClasses.Association,
			)!;
		} else if (nodeAssociations.length > 0) {
			throw new ZWaveError(
				`Node ${nodeId} does not support associations!`,
				ZWaveErrorCodes.CC_NotSupported,
			);
		}
		if (node.supportsCC(CommandClasses["Multi Channel Association"])) {
			mcInstance = node.createCCInstanceUnsafe<MultiChannelAssociationCC>(
				CommandClasses["Multi Channel Association"],
			)!;
		} else if (endpointAssociations.length > 0) {
			throw new ZWaveError(
				`Node ${nodeId} does not support multi channel associations!`,
				ZWaveErrorCodes.CC_NotSupported,
			);
		}

		const assocGroupCount = assocInstance?.getGroupCountCached() ?? 0;
		const mcGroupCount = mcInstance?.getGroupCountCached() ?? 0;
		const groupCount = Math.max(assocGroupCount, mcGroupCount);
		if (group > groupCount) {
			throw new ZWaveError(
				`Group ${group} does not exist on node ${nodeId}`,
				ZWaveErrorCodes.AssociationCC_InvalidGroup,
			);
		}

		const groupIsMultiChannel =
			!!mcInstance &&
			group <= mcGroupCount &&
			!node.deviceConfig?.associations?.get(group)?.noEndpoint;

		if (groupIsMultiChannel) {
			// Check that all associations are allowed
			const disallowedAssociations = associations.filter(
				(a) => !this.isAssociationAllowed(nodeId, group, a),
			);
			if (disallowedAssociations.length) {
				let message = `The following associations are not allowed:`;
				message += disallowedAssociations
					.map(
						(a) =>
							`\n· Node ${a.nodeId}${
								a.endpoint ? `, endpoint ${a.endpoint}` : ""
							}`,
					)
					.join("");
				throw new ZWaveError(
					message,
					ZWaveErrorCodes.AssociationCC_NotAllowed,
				);
			}

			// And add them
			await node.commandClasses[
				"Multi Channel Association"
			].addDestinations({
				groupId: group,
				nodeIds: nodeAssociations,
				endpoints: endpointAssociations,
			});
			// Refresh the association list
			await node.commandClasses["Multi Channel Association"].getGroup(
				group,
			);
		} else {
			// Although the node supports multi channel associations, this group only supports "normal" associations
			if (associations.some((a) => a.endpoint != undefined)) {
				throw new ZWaveError(
					`Node ${nodeId}, group ${group} does not support multi channel associations!`,
					ZWaveErrorCodes.CC_NotSupported,
				);
			}

			// Check that all associations are allowed
			const disallowedAssociations = associations.filter(
				(a) => !this.isAssociationAllowed(nodeId, group, a),
			);
			if (disallowedAssociations.length) {
				throw new ZWaveError(
					`The associations to the following nodes are not allowed: ${disallowedAssociations
						.map((a) => a.nodeId)
						.join(", ")}`,
					ZWaveErrorCodes.AssociationCC_NotAllowed,
				);
			}

			await node.commandClasses.Association.addNodeIds(
				group,
				...associations.map((a) => a.nodeId),
			);
			// Refresh the association list
			await node.commandClasses.Association.getGroup(group);
		}
	}

	/**
	 * Removes the specific associations from a node
	 */
	public async removeAssociations(
		nodeId: number,
		group: number,
		associations: Association[],
	): Promise<void> {
		const node = this.nodes.getOrThrow(nodeId);

		let groupExistsAsMultiChannel = false;
		// Split associations into conventional and endpoint associations
		const nodeAssociations = distinct(
			associations
				.filter((a) => a.endpoint == undefined)
				.map((a) => a.nodeId),
		);
		const endpointAssociations = associations.filter(
			(a) => a.endpoint != undefined,
		) as EndpointAddress[];

		// Removing associations is not either/or - we could have a device with duplicated associations between
		// Association CC and Multi Channel Association CC
		if (node.supportsCC(CommandClasses["Multi Channel Association"])) {
			// Prefer multi channel associations
			const cc = node.createCCInstanceUnsafe<MultiChannelAssociationCC>(
				CommandClasses["Multi Channel Association"],
			)!;
			if (group > cc.getGroupCountCached()) {
				throw new ZWaveError(
					`Group ${group} does not exist on node ${nodeId}`,
					ZWaveErrorCodes.AssociationCC_InvalidGroup,
				);
			} else {
				// Remember that the group exists as a multi channel group, otherwise the "normal" association code
				// will throw if we try to remove the association from a non-existing "normal" group
				groupExistsAsMultiChannel = true;
			}

			await node.commandClasses[
				"Multi Channel Association"
			].removeDestinations({
				groupId: group,
				nodeIds: nodeAssociations,
				endpoints: endpointAssociations,
			});
			// Refresh the multi channel association list
			await node.commandClasses["Multi Channel Association"].getGroup(
				group,
			);
		} else if (endpointAssociations.length > 0) {
			throw new ZWaveError(
				`Node ${nodeId} does not support multi channel associations!`,
				ZWaveErrorCodes.CC_NotSupported,
			);
		}

		if (node.supportsCC(CommandClasses.Association)) {
			// Use normal associations as a fallback
			const cc = node.createCCInstanceUnsafe<AssociationCC>(
				CommandClasses.Association,
			)!;
			if (group > cc.getGroupCountCached()) {
				// Don't throw if the group existed as multi channel - this branch is only a fallback
				if (groupExistsAsMultiChannel) return;
				throw new ZWaveError(
					`Group ${group} does not exist on node ${nodeId}`,
					ZWaveErrorCodes.AssociationCC_InvalidGroup,
				);
			}
			// Remove the remaining node associations
			await node.commandClasses.Association.removeNodeIds({
				groupId: group,
				nodeIds: nodeAssociations,
			});
			// Refresh the association list
			await node.commandClasses.Association.getGroup(group);
		} else if (nodeAssociations.length > 0) {
			throw new ZWaveError(
				`Node ${nodeId} does not support associations!`,
				ZWaveErrorCodes.CC_NotSupported,
			);
		}
	}

	/**
	 * Removes a node from all other nodes' associations
	 * WARNING: It is not recommended to await this method
	 */
	public async removeNodeFromAllAssociations(nodeId: number): Promise<void> {
		// Create all async tasks
		const tasks = [...this.nodes.values()]
			.filter((node) => node.id !== this._ownNodeId && node.id !== nodeId)
			.map((node) => {
				// Prefer multi channel associations if that is available
				if (
					node.commandClasses[
						"Multi Channel Association"
					].isSupported()
				) {
					return node.commandClasses[
						"Multi Channel Association"
					].removeDestinations({
						nodeIds: [nodeId],
					});
				} else if (node.commandClasses.Association.isSupported()) {
					return node.commandClasses.Association.removeNodeIdsFromAllGroups(
						[nodeId],
					);
				}
			})
			.filter((task) => !!task) as Promise<void>[];
		await Promise.all(tasks);
	}

	/**
	 * Tests if a node is marked as failed in the controller's memory
	 * @param nodeId The id of the node in question
	 */
	public async isFailedNode(nodeId: number): Promise<boolean> {
		const result = await this.driver.sendMessage<IsFailedNodeResponse>(
			new IsFailedNodeRequest(this.driver, { failedNodeId: nodeId }),
		);
		return result.result;
	}

	/**
	 * Removes a failed node from the controller's memory. If the process fails, this will throw an exception with the details why.
	 * @param nodeId The id of the node to remove
	 */
	public async removeFailedNode(nodeId: number): Promise<void> {
		const node = this.nodes.getOrThrow(nodeId);
		if (await node.ping()) {
			throw new ZWaveError(
				`The node removal process could not be started because the node responded to a ping.`,
				ZWaveErrorCodes.ReplaceFailedNode_Failed,
			);
		}

		const result = await this.driver.sendMessage<
			RemoveFailedNodeRequestStatusReport | RemoveFailedNodeResponse
		>(new RemoveFailedNodeRequest(this.driver, { failedNodeId: nodeId }));

		if (result instanceof RemoveFailedNodeResponse) {
			// This implicates that the process was unsuccessful.
			let message = `The node removal process could not be started due to the following reasons:`;
			if (
				!!(
					result.removeStatus &
					RemoveFailedNodeStartFlags.NotPrimaryController
				)
			) {
				message += "\n· This controller is not the primary controller";
			}
			if (
				!!(
					result.removeStatus &
					RemoveFailedNodeStartFlags.NodeNotFound
				)
			) {
				message += `\n· Node ${nodeId} is not in the list of failed nodes`;
			}
			if (
				!!(
					result.removeStatus &
					RemoveFailedNodeStartFlags.RemoveProcessBusy
				)
			) {
				message += `\n· The node removal process is currently busy`;
			}
			if (
				!!(
					result.removeStatus &
					RemoveFailedNodeStartFlags.RemoveFailed
				)
			) {
				message += `\n· The controller is busy or the node has responded`;
			}
			throw new ZWaveError(
				message,
				ZWaveErrorCodes.RemoveFailedNode_Failed,
			);
		} else {
			switch (result.removeStatus) {
				case RemoveFailedNodeStatus.NodeOK:
					throw new ZWaveError(
						`The node could not be removed because it has responded`,
						ZWaveErrorCodes.RemoveFailedNode_NodeOK,
					);
				case RemoveFailedNodeStatus.NodeNotRemoved:
					throw new ZWaveError(
						`The removal process could not be completed`,
						ZWaveErrorCodes.RemoveFailedNode_Failed,
					);
				default:
					// If everything went well, the status is RemoveFailedNodeStatus.NodeRemoved

					// Emit the removed event so the driver and applications can react
					this.emit("node removed", this.nodes.get(nodeId)!, false);
					// and forget the node
					this._nodes.delete(nodeId);

					return;
			}
		}
	}

	/**
	 * Replace a failed node from the controller's memory. If the process fails, this will throw an exception with the details why.
	 * @param nodeId The id of the node to replace
	 * @param includeNonSecure Whether the new node should be included non-securely, even if it supports Security. By default, all nodes will be included securely if possible
	 *
	 */
	public async replaceFailedNode(
		nodeId: number,
		includeNonSecure: boolean = false,
	): Promise<boolean> {
		// don't start it twice
		if (this._inclusionActive || this._exclusionActive) return false;

		this.driver.controllerLog.print(
			`starting replace failed node process...`,
		);

		const node = this.nodes.getOrThrow(nodeId);
		if (await node.ping()) {
			throw new ZWaveError(
				`The node replace process could not be started because the node responded to a ping.`,
				ZWaveErrorCodes.ReplaceFailedNode_Failed,
			);
		}

		this._includeNonSecure = includeNonSecure;

		const result = await this.driver.sendMessage<ReplaceFailedNodeResponse>(
			new ReplaceFailedNodeRequest(this.driver, {
				failedNodeId: nodeId,
			}),
		);

		if (!result.isOK()) {
			// This implicates that the process was unsuccessful.
			let message = `The node replace process could not be started due to the following reasons:`;
			if (
				!!(
					result.replaceStatus &
					ReplaceFailedNodeStartFlags.NotPrimaryController
				)
			) {
				message += "\n· This controller is not the primary controller";
			}
			if (
				!!(
					result.replaceStatus &
					ReplaceFailedNodeStartFlags.NodeNotFound
				)
			) {
				message += `\n· Node ${nodeId} is not in the list of failed nodes`;
			}
			if (
				!!(
					result.replaceStatus &
					ReplaceFailedNodeStartFlags.ReplaceProcessBusy
				)
			) {
				message += `\n· The node replace process is currently busy`;
			}
			if (
				!!(
					result.replaceStatus &
					ReplaceFailedNodeStartFlags.ReplaceFailed
				)
			) {
				message += `\n· The controller is busy or the node has responded`;
			}
			throw new ZWaveError(
				message,
				ZWaveErrorCodes.ReplaceFailedNode_Failed,
			);
		} else {
			// Remember which node we're trying to replace
			this._nodePendingReplace = this.nodes.get(nodeId);
			this._replaceFailedPromise = createDeferredPromise();
			return this._replaceFailedPromise;
		}
	}

	/**
	 * @internal
	 * Serializes the controller information and all nodes to store them in a cache.
	 */
	public serialize(): JSONObject {
		return {
			nodes: composeObject(
				[...this.nodes.entries()].map(
					([id, node]) =>
						[id.toString(), node.serialize()] as [string, unknown],
				),
			),
		};
	}

	/**
	 * @internal
	 * Deserializes the controller information and all nodes from the cache.
	 */
	public async deserialize(serialized: any): Promise<void> {
		if (isObject(serialized.nodes)) {
			for (const nodeId of Object.keys(serialized.nodes)) {
				const serializedNode = serialized.nodes[nodeId];
				if (
					!serializedNode ||
					typeof serializedNode.id !== "number" ||
					serializedNode.id.toString() !== nodeId
				) {
					throw new ZWaveError(
						"The cache file is invalid",
						ZWaveErrorCodes.Driver_InvalidCache,
					);
				}

				if (this.nodes.has(serializedNode.id)) {
					await this.nodes
						.get(serializedNode.id)!
						.deserialize(serializedNode);
				}
			}
		}
	}
}
