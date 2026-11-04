// REQ-UI-030 — dashboard use cases (ADR-020): read what the user may see, create from a persona template or an
// explicit widget list, customise, share, delete and pick a default. Only the owner changes a dashboard; a shared
// dashboard is read by everyone in the tenant. Mutations are audited by the global interceptor.
import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DASHBOARD } from '@openmap/constants';
import type { Dashboard, DashboardInput } from '@openmap/contracts';
import { DASHBOARDS_REPOSITORY, type DashboardsRepository } from './dashboards.repository.js';
import type { DashboardView } from './dashboards.types.js';

@Injectable()
export class DashboardsService {
  constructor(@Inject(DASHBOARDS_REPOSITORY) private readonly repo: DashboardsRepository) {}

  async list(tenantId: string, user: string): Promise<DashboardView[]> {
    return (await this.repo.visible(tenantId, user)).map((d) => view(d, user));
  }

  async create(tenantId: string, user: string, input: DashboardInput): Promise<DashboardView> {
    const owned = await this.repo.countOwned(tenantId, user);
    if (owned >= DASHBOARD.maxPerOwner) throw new ForbiddenException('dashboard limit of ' + String(DASHBOARD.maxPerOwner) + ' per user reached');
    // The first dashboard a user creates is their landing page until they pick another.
    return view(await this.repo.create(tenantId, user, input, owned === 0), user);
  }

  async update(tenantId: string, user: string, id: string, input: DashboardInput): Promise<DashboardView> {
    await this.requireOwned(tenantId, user, id);
    return view(await this.repo.update(tenantId, id, input), user);
  }

  async remove(tenantId: string, user: string, id: string): Promise<boolean> {
    await this.requireOwned(tenantId, user, id);
    await this.repo.remove(tenantId, id);
    return true;
  }

  async setDefault(tenantId: string, user: string, id: string): Promise<DashboardView> {
    await this.requireOwned(tenantId, user, id);
    return view(await this.repo.setDefault(tenantId, user, id), user);
  }

  private async requireOwned(tenantId: string, user: string, id: string): Promise<Dashboard> {
    const dashboard = await this.repo.byId(tenantId, id);
    if (!dashboard) throw new NotFoundException('dashboard ' + id + ' not found');
    if (dashboard.owner !== user) throw new ForbiddenException('only the owner of a dashboard may change it');
    return dashboard;
  }
}

function view(dashboard: Dashboard, user: string): DashboardView {
  return { ...dashboard, mine: dashboard.owner === user };
}
