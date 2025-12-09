import React from 'react';
import { GeoPlacesClient, ClientConfig } from '@chaosity/location-client';
interface LocationClientContextValue {
    config: ClientConfig | null;
    client: GeoPlacesClient | null;
    loading: boolean;
    error: string | null;
}
export interface LocationClientProviderProps {
    children: React.ReactNode;
    getConfig: () => Promise<ClientConfig>;
}
export declare function LocationClientProvider({ children, getConfig }: LocationClientProviderProps): React.JSX.Element;
export declare function useLocationClient(): LocationClientContextValue;
export {};
