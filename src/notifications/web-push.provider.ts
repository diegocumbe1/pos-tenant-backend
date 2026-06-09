import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import webPush = require('web-push');

export interface WebPushSubscriptionInput {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface WebPushPayload {
  title: string;
  body?: string;
  icon?: string;
  badge?: string;
  url?: string;
  data?: Record<string, unknown>;
}

@Injectable()
export class WebPushProvider {
  private readonly publicKey?: string;
  private readonly privateKey?: string;
  private readonly subject: string;

  constructor(config: ConfigService) {
    this.publicKey = config.get<string>('VAPID_PUBLIC_KEY')?.trim();
    this.privateKey = config.get<string>('VAPID_PRIVATE_KEY')?.trim();
    this.subject =
      config.get<string>('VAPID_SUBJECT')?.trim() ??
      'mailto:soporte@uselynko.com';

    if (this.isConfigured()) {
      webPush.setVapidDetails(this.subject, this.publicKey!, this.privateKey!);
    }
  }

  isConfigured() {
    return Boolean(this.publicKey && this.privateKey && this.subject);
  }

  getPublicKey() {
    if (!this.publicKey) {
      throw new ServiceUnavailableException({
        code: 'WEB_PUSH_NOT_CONFIGURED',
        message: 'Web Push VAPID public key is not configured',
      });
    }
    return this.publicKey;
  }

  async send(subscription: WebPushSubscriptionInput, payload: WebPushPayload) {
    if (!this.isConfigured()) {
      throw new ServiceUnavailableException({
        code: 'WEB_PUSH_NOT_CONFIGURED',
        message: 'Web Push VAPID keys are not configured',
      });
    }

    const pushSubscription = {
      endpoint: subscription.endpoint,
      keys: {
        p256dh: subscription.p256dh,
        auth: subscription.auth,
      },
    };

    return webPush.sendNotification(
      pushSubscription,
      JSON.stringify({
        title: payload.title,
        body: payload.body,
        icon: payload.icon ?? '/icons/icon-192.png',
        badge: payload.badge ?? '/icons/icon-192.png',
        data: {
          url: payload.url ?? '/app',
          ...(payload.data ?? {}),
        },
      }),
    );
  }
}
