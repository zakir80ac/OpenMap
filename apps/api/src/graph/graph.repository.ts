// REQ-DEP-001 — per-user layer visibility stored in user_preferences; the graph itself is read
// through @openmap/graph. Interface plus Prisma implementation.
import { Injectable } from '@nestjs/common';
import { CI_LAYERS, type CiLayer } from '@openmap/contracts';
import { PrismaService } from '../db/prisma.service.js';

export const LAYER_PREFERENCES = Symbol('LAYER_PREFERENCES');

export interface LayerPreferenceRepository {
  /** Layers the user chose to see; null when the user never changed the default (everything visible). */
  visibleLayers(tenantId: string, userId: string): Promise<CiLayer[] | null>;
  setVisible(tenantId: string, userId: string, layer: CiLayer, visible: boolean): Promise<CiLayer[]>;
}

@Injectable()
export class PrismaLayerPreferenceRepository implements LayerPreferenceRepository {
  constructor(private readonly prisma: PrismaService) {}

  async visibleLayers(tenantId: string, userId: string): Promise<CiLayer[] | null> {
    const row = await this.prisma.client.userPreference.findUnique({ where: { tenantId_userId: { tenantId, userId } } });
    return row ? row.visibleLayers : null;
  }

  async setVisible(tenantId: string, userId: string, layer: CiLayer, visible: boolean): Promise<CiLayer[]> {
    const current = (await this.visibleLayers(tenantId, userId)) ?? [...CI_LAYERS];
    const next = visible ? [...new Set([...current, layer])] : current.filter((l) => l !== layer);
    const ordered = CI_LAYERS.filter((l) => next.includes(l));
    const row = await this.prisma.client.userPreference.upsert({
      where: { tenantId_userId: { tenantId, userId } },
      create: { tenantId, userId, visibleLayers: ordered, preferences: {} },
      update: { visibleLayers: ordered },
    });
    return row.visibleLayers;
  }
}
