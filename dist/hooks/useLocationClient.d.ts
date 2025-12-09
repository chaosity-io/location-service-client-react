import { GeoPlacesClient, ClientConfig } from '@chaosity/location-client';
export interface UseLocationClientOptions {
    getConfig: () => Promise<ClientConfig>;
}
export declare function useLocationClient(options: UseLocationClientOptions): {
    config: ClientConfig | null;
    client: GeoPlacesClient | null;
    loading: boolean;
    error: string | null;
};
