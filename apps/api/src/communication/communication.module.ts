import { Module } from '@nestjs/common';
import { DocumentsModule } from '../documents/documents.module';
import { CommunicationController } from './communication.controller';
import { CommunicationService } from './communication.service';
import { config } from '../config';
import { createSignatureProvider, SIGNATURE_PROVIDER } from './signature-provider';
import { SignaturesService } from './signatures.service';

@Module({
  imports: [DocumentsModule],
  controllers: [CommunicationController],
  providers: [CommunicationService, SignaturesService, { provide: SIGNATURE_PROVIDER, useFactory: () => createSignatureProvider(config.signatureProvider) }],
})
export class CommunicationModule {}
