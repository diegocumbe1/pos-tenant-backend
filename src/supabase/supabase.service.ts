import {
  Injectable,
  InternalServerErrorException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

type InviteUserOptions = {
  redirectTo?: string;
  data?: Record<string, unknown>;
};

@Injectable()
export class SupabaseService {
  private readonly logger = new Logger(SupabaseService.name);
  private _admin?: SupabaseClient;
  private _public?: SupabaseClient;
  private assetsBucketReady = false;

  constructor(private readonly config: ConfigService) {}

  get admin(): SupabaseClient {
    if (!this._admin) {
      const url = this.config.getOrThrow<string>('SUPABASE_URL');
      const serviceKey = this.config.getOrThrow<string>(
        'SUPABASE_SERVICE_ROLE_KEY',
      );
      this._admin = createClient(url, serviceKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
    }
    return this._admin;
  }

  get public(): SupabaseClient {
    if (!this._public) {
      this._public = this.createPublicClient();
    }
    return this._public;
  }

  get inviteRedirectUrl(): string {
    return (
      this.config.get<string>('SUPABASE_INVITE_REDIRECT_TO') ||
      'http://localhost:3000/auth/accept-invite'
    );
  }

  get recoveryRedirectUrl(): string {
    return (
      this.config.get<string>('SUPABASE_RECOVERY_REDIRECT_TO') ||
      'http://localhost:3000/reset-password'
    );
  }

  get assetsBucket(): string {
    return this.config.get<string>('SUPABASE_ASSETS_BUCKET') || 'lynko-assets';
  }

  async inviteUserByEmail(email: string, options: InviteUserOptions = {}) {
    const redirectTo = options.redirectTo || this.inviteRedirectUrl;
    const metadata = options.data || {};

    const { data, error } = await this.admin.auth.admin.inviteUserByEmail(
      email,
      {
        redirectTo,
        data: metadata,
      },
    );

    if (error) {
      this.logger.error(`Failed to invite ${email}: ${error.message}`);
      throw new InternalServerErrorException(
        `Supabase invite failed: ${error.message}`,
      );
    }

    if (!data.user?.id) {
      throw new InternalServerErrorException(
        'Supabase invite failed: user was not returned',
      );
    }

    await this.setAppMetadata(data.user.id, metadata);
    return data.user;
  }

  async inviteUser(email: string, appMetadata: Record<string, unknown>) {
    return this.inviteUserByEmail(email, {
      data: appMetadata,
    });
  }

  async createUser(email: string, appMetadata: Record<string, unknown>) {
    const { data, error } = await this.admin.auth.admin.createUser({
      email,
      email_confirm: true,
      app_metadata: appMetadata,
    });
    if (error) {
      this.logger.error(`Failed to create ${email}: ${error.message}`);
      throw new InternalServerErrorException(
        `Supabase createUser failed: ${error.message}`,
      );
    }
    return data.user!;
  }

  async setAppMetadata(userId: string, appMetadata: Record<string, unknown>) {
    const { error } = await this.admin.auth.admin.updateUserById(userId, {
      app_metadata: appMetadata,
    });
    if (error) {
      throw new InternalServerErrorException(
        `Supabase updateUser failed: ${error.message}`,
      );
    }
  }

  async setPassword(userId: string, password: string) {
    const { error } = await this.admin.auth.admin.updateUserById(userId, {
      password,
    });
    if (error) {
      throw new InternalServerErrorException(
        `Supabase setPassword failed: ${error.message}`,
      );
    }
  }

  async updateUserEmail(userId: string, newEmail: string) {
    const { error } = await this.admin.auth.admin.updateUserById(userId, {
      email: newEmail,
      email_confirm: true,
    });
    if (error) {
      this.logger.error(
        `Failed to update email for ${userId}: ${error.message}`,
      );
      throw new InternalServerErrorException(
        `Supabase updateUserEmail failed: ${error.message}`,
      );
    }
  }

  async deleteUser(userId: string) {
    const { error } = await this.admin.auth.admin.deleteUser(userId);
    if (error) {
      throw new InternalServerErrorException(
        `Supabase deleteUser failed: ${error.message}`,
      );
    }
  }

  async signInWithPassword(email: string, password: string) {
    const { data, error } = await this.public.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      this.logger.warn(`Sign-in failed for ${email}: ${error.message}`);
      throw new UnauthorizedException(error.message || 'Invalid credentials');
    }

    if (!data.session || !data.user) {
      throw new UnauthorizedException('Sign-in did not return a session');
    }

    return { session: data.session, user: data.user };
  }

  async setSession(accessToken: string, refreshToken: string) {
    const client = this.createPublicClient();
    const { data, error } = await client.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken,
    });

    if (error) {
      this.logger.warn(`Set session failed: ${error.message}`);
      throw new UnauthorizedException(
        error.message || 'Invalid invite session',
      );
    }

    if (!data.session || !data.user) {
      throw new UnauthorizedException('Set session did not return a session');
    }

    return { session: data.session, user: data.user };
  }

  async sendPasswordRecoveryEmail(email: string, redirectTo?: string) {
    const { error } = await this.admin.auth.resetPasswordForEmail(email, {
      redirectTo: redirectTo || this.recoveryRedirectUrl,
    });

    if (error) {
      this.logger.error(
        `Password recovery failed for ${email}: ${error.message}`,
      );
      throw new InternalServerErrorException(
        `Supabase password recovery failed: ${error.message}`,
      );
    }
  }

  async generateMagicLink(email: string) {
    const { data, error } = await this.admin.auth.admin.generateLink({
      type: 'magiclink',
      email,
      options: { redirectTo: this.inviteRedirectUrl },
    });
    if (error) {
      throw new InternalServerErrorException(
        `Supabase generateLink failed: ${error.message}`,
      );
    }
    return data.properties?.action_link ?? null;
  }

  async uploadPublicAsset(params: {
    path: string;
    buffer: Buffer;
    contentType: string;
    upsert?: boolean;
  }) {
    await this.ensureAssetsBucket();

    const { data, error } = await this.admin.storage
      .from(this.assetsBucket)
      .upload(params.path, params.buffer, {
        contentType: params.contentType,
        upsert: params.upsert ?? false,
      });

    if (error) {
      this.logger.error(`Asset upload failed: ${error.message}`);
      throw new InternalServerErrorException(
        `Supabase asset upload failed: ${error.message}`,
      );
    }

    const { data: publicUrlData } = this.admin.storage
      .from(this.assetsBucket)
      .getPublicUrl(data.path);

    return {
      bucket: this.assetsBucket,
      path: data.path,
      publicUrl: publicUrlData.publicUrl,
    };
  }

  async deletePublicAsset(path: string) {
    await this.ensureAssetsBucket();

    const { error } = await this.admin.storage
      .from(this.assetsBucket)
      .remove([path]);

    if (error) {
      this.logger.error(`Asset delete failed: ${error.message}`);
      throw new InternalServerErrorException(
        `Supabase asset delete failed: ${error.message}`,
      );
    }
  }

  private async ensureAssetsBucket() {
    if (this.assetsBucketReady) return;

    const { error: getError } = await this.admin.storage.getBucket(
      this.assetsBucket,
    );

    if (!getError) {
      this.assetsBucketReady = true;
      return;
    }

    const { error: createError } = await this.admin.storage.createBucket(
      this.assetsBucket,
      {
        public: true,
        fileSizeLimit: '5MB',
        allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
      },
    );

    if (createError) {
      this.logger.error(`Assets bucket setup failed: ${createError.message}`);
      throw new InternalServerErrorException(
        `Supabase assets bucket setup failed: ${createError.message}`,
      );
    }

    this.assetsBucketReady = true;
  }

  private createPublicClient(): SupabaseClient {
    const url = this.config.getOrThrow<string>('SUPABASE_URL');
    const anonKey = this.config.getOrThrow<string>('SUPABASE_ANON_KEY');
    return createClient(url, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }
}
