import {
  EgressClient,
  EgressStatus,
  EncodedFileOutput,
  EncodedFileType,
  EncodingOptionsPreset,
  RoomServiceClient,
  S3Upload,
} from 'livekit-server-sdk';
import type { EgressState, MediaPort } from './recording.service.js';

export interface LiveKitMediaOptions {
  apiUrl: string;
  apiKey: string;
  apiSecret: string;
  /** Storage as Egress itself reaches it (inside the compose network), which can differ from the API's own endpoint. */
  s3: { endpoint: string; bucket: string; accessKey: string; secretKey: string; region: string };
}

/** LiveKit room metadata and Egress (room composite recording to S3-compatible storage). */
export class LiveKitMedia implements MediaPort {
  private readonly rooms: RoomServiceClient;
  private readonly egress: EgressClient;

  constructor(private readonly o: LiveKitMediaOptions) {
    this.rooms = new RoomServiceClient(o.apiUrl, o.apiKey, o.apiSecret);
    this.egress = new EgressClient(o.apiUrl, o.apiKey, o.apiSecret);
  }

  /** Merges `recording` into the room metadata (other keys are kept). Clients read it on join and on change. */
  async setRecordingFlag(room: string, on: boolean): Promise<void> {
    const [existing] = await this.rooms.listRooms([room]);
    if (!existing) throw new Error('requested room does not exist');
    let meta: Record<string, unknown> = {};
    try {
      const parsed: unknown = existing.metadata ? JSON.parse(existing.metadata) : {};
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) meta = parsed as Record<string, unknown>;
    } catch {
      /* not JSON: replaced */
    }
    if (on) meta.recording = true;
    else delete meta.recording;
    await this.rooms.updateRoomMetadata(room, JSON.stringify(meta));
  }

  async startRoomComposite(room: string, key: string): Promise<{ egressId: string }> {
    const { s3 } = this.o;
    const file = new EncodedFileOutput({
      fileType: EncodedFileType.MP4,
      filepath: key,
      disableManifest: true,
      output: {
        case: 's3',
        value: new S3Upload({ accessKey: s3.accessKey, secret: s3.secretKey, region: s3.region, endpoint: s3.endpoint, bucket: s3.bucket, forcePathStyle: true }),
      },
    });
    const info = await this.egress.startRoomCompositeEgress(room, { file }, { layout: 'grid', encodingOptions: EncodingOptionsPreset.H264_720P_30 });
    return { egressId: info.egressId };
  }

  async stop(egressId: string): Promise<void> {
    await this.egress.stopEgress(egressId);
  }

  async status(egressId: string): Promise<{ state: EgressState }> {
    const [info] = await this.egress.listEgress({ egressId });
    if (!info) return { state: 'failed' };
    switch (info.status) {
      case EgressStatus.EGRESS_COMPLETE:
        return { state: 'complete' };
      case EgressStatus.EGRESS_STARTING:
      case EgressStatus.EGRESS_ACTIVE:
      case EgressStatus.EGRESS_ENDING:
        return { state: 'active' };
      default:
        return { state: 'failed' };
    }
  }
}
