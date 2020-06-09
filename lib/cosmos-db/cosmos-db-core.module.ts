import { CosmosClient } from '@azure/cosmos';
import {DynamicModule, Global, Inject, Module, Provider, Type, Scope} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { defer } from 'rxjs';
import { COSMOS_DB_CONNECTION_NAME, COSMOS_DB_MODULE_OPTIONS } from './cosmos-db.constants';
import {
  AzureCosmosDbModuleAsyncOptions,
  AzureCosmosDbOptions,
  AzureCosmosDbOptionsFactory,
} from './cosmos-db.interface';
import { getConnectionToken, handleRetry } from './cosmos-db.utils';

@Global()
@Module({})
export class AzureCosmosDbCoreModule {
  constructor(
    @Inject(COSMOS_DB_CONNECTION_NAME) private readonly connectionName: string,
    private readonly moduleRef: ModuleRef,
  ) {}

  static forRoot(options: AzureCosmosDbOptions): DynamicModule {
    const { resourceTokensCallback, dbName, retryAttempts, retryDelay, connectionName, ...cosmosDbOptions } = options;

    const cosmosConnectionName = getConnectionToken(connectionName);

    const cosmosConnectionNameProvider = {
      provide: COSMOS_DB_CONNECTION_NAME,
      useValue: cosmosConnectionName,
    };

    const connectionProvider = {
      scope: Scope.REQUEST,
      provide: cosmosConnectionName,
      useFactory: async (): Promise<any> => {
        return await defer(async () => {
          if (cosmosDbOptions.key) {
            console.log('Use CosmosDB key for initial COsmosDB client.');
            const client = new CosmosClient(cosmosDbOptions);
            const dbResponse = await client.databases.createIfNotExists({
              id: dbName,
            });
            return dbResponse.database;
          }
          // Token expire time is 60 mins.
          if(cosmosDbOptions.client && (Date.now() - cosmosDbOptions.lastUpdate < 3600000 * 0.8)) {
            // console.log('Use exited CosmosDB Client');
            return cosmosDbOptions.client.database(dbName);
          }
          if (resourceTokensCallback) {
            const resourceTokens = await resourceTokensCallback();
            console.log('Generate a new resource token for initial CosmosDB Client success.');
            cosmosDbOptions.resourceTokens = resourceTokens;
          }
          const tokenClient = new CosmosClient(cosmosDbOptions);

          // Hold client in 60 * 0.8 mins.
          cosmosDbOptions.client = tokenClient;
          cosmosDbOptions.lastUpdate = Date.now();

          if (cosmosDbOptions.resourceTokens) {
            return tokenClient.database(dbName);
          }
        })
            .pipe(handleRetry(retryAttempts, retryDelay))
            .toPromise();
      }
    };

    return {
      module: AzureCosmosDbCoreModule,
      providers: [connectionProvider, cosmosConnectionNameProvider],
      exports: [connectionProvider],
    };
  }

  static forRootAsync(options: AzureCosmosDbModuleAsyncOptions): DynamicModule {
    const cosmosConnectionName = getConnectionToken(options.connectionName);

    const cosmosConnectionNameProvider = {
      provide: COSMOS_DB_CONNECTION_NAME,
      useValue: cosmosConnectionName,
    };

    const connectionProvider = {
      provide: cosmosConnectionName,
      useFactory: async (cosmosModuleOptions: AzureCosmosDbOptions): Promise<any> => {
        const { dbName, retryAttempts, retryDelay, connectionName, ...cosmosOptions } = cosmosModuleOptions;

        return await defer(async () => {
          const client = new CosmosClient(cosmosOptions);
          const dbResponse = await client.databases.createIfNotExists({
            id: dbName,
          });
          return dbResponse.database;
        })
          .pipe(handleRetry(retryAttempts, retryDelay))
          .toPromise();
      },
      inject: [COSMOS_DB_MODULE_OPTIONS],
    };
    const asyncProviders = this.createAsyncProviders(options);
    return {
      module: AzureCosmosDbCoreModule,
      imports: options.imports,
      providers: [...asyncProviders, connectionProvider, cosmosConnectionNameProvider],
      exports: [connectionProvider],
    };
  }

  private static createAsyncProviders(options: AzureCosmosDbModuleAsyncOptions): Provider[] {
    if (options.useExisting || options.useFactory) {
      return [this.createAsyncOptionsProvider(options)];
    }
    const useClass = options.useClass as Type<AzureCosmosDbOptionsFactory>;
    return [
      this.createAsyncOptionsProvider(options),
      {
        provide: useClass,
        useClass,
      },
    ];
  }

  private static createAsyncOptionsProvider(options: AzureCosmosDbModuleAsyncOptions): Provider {
    if (options.useFactory) {
      return {
        provide: COSMOS_DB_MODULE_OPTIONS,
        useFactory: options.useFactory,
        inject: options.inject || [],
      };
    }
    // `as Type<AzureCosmosDbOptionsFactory>` is a workaround for microsoft/TypeScript#31603
    const inject = [(options.useClass || options.useExisting) as Type<AzureCosmosDbOptionsFactory>];
    return {
      provide: COSMOS_DB_MODULE_OPTIONS,
      useFactory: async (optionsFactory: AzureCosmosDbOptionsFactory) =>
        await optionsFactory.createAzureCosmosDbOptions(),
      inject,
    };
  }
}
