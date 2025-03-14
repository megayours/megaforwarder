/**
 * Buffer utility functions for encoding and decoding different data types
 */

/**
 * Encodes any data into a Buffer
 * @param data Any data to encode (including objects with bigint)
 * @returns Buffer representation of the data
 */
export function encode(data: unknown): Buffer {
  return _encode(data);
}

function _encode(data: unknown): Buffer {
  // Handle null or undefined
  if (data === null || data === undefined) {
    return Buffer.from([0]); // Special marker for null/undefined
  }

  // If it's already a Buffer, just return it to prevent double encoding
  if (Buffer.isBuffer(data)) {
    const typeMarker = Buffer.from([5]); // Buffer type marker
    return Buffer.concat([typeMarker, data]);
  }

  // Handle primitive types
  if (typeof data === 'string') {
    const typeMarker = Buffer.from([1]); // String type marker
    const contentBuffer = Buffer.from(data, 'utf-8');
    return Buffer.concat([typeMarker, contentBuffer]);
  }

  if (typeof data === 'number') {
    const typeMarker = Buffer.from([2]); // Number type marker
    const contentBuffer = Buffer.from(data.toString(), 'utf-8');
    return Buffer.concat([typeMarker, contentBuffer]);
  }

  if (typeof data === 'boolean') {
    const typeMarker = Buffer.from([3]); // Boolean type marker
    const contentBuffer = Buffer.from(data ? '1' : '0', 'utf-8');
    return Buffer.concat([typeMarker, contentBuffer]);
  }

  if (typeof data === 'bigint') {
    const typeMarker = Buffer.from([4]); // BigInt type marker
    const contentBuffer = Buffer.from(data.toString(), 'utf-8');
    return Buffer.concat([typeMarker, contentBuffer]);
  }

  // Handle Date
  if (data instanceof Date) {
    const typeMarker = Buffer.from([6]); // Date type marker
    const contentBuffer = Buffer.from(data.getTime().toString(), 'utf-8');
    return Buffer.concat([typeMarker, contentBuffer]);
  }

  // Handle arrays
  if (Array.isArray(data)) {
    const typeMarker = Buffer.from([7]); // Array type marker
    
    // Encode length as 4 bytes
    const lengthBuffer = Buffer.alloc(4);
    lengthBuffer.writeUInt32BE(data.length, 0);
    
    // Encode each element
    const encodedElements = data.map(item => _encode(item));
    
    // Concatenate elements with their sizes
    const elementsWithSizes: Buffer[] = [];
    encodedElements.forEach(encodedElement => {
      const sizeBuffer = Buffer.alloc(4);
      sizeBuffer.writeUInt32BE(encodedElement.length, 0);
      elementsWithSizes.push(sizeBuffer, encodedElement);
    });
    
    return Buffer.concat([typeMarker, lengthBuffer, ...elementsWithSizes]);
  }

  // Handle objects
  if (typeof data === 'object') {
    const typeMarker = Buffer.from([8]); // Object type marker
    
    // Get all entries and sort them by key alphanumerically
    const entries = Object.entries(data as Record<string, unknown>)
      .sort(([keyA], [keyB]) => keyA.localeCompare(keyB, undefined, { numeric: true }));
    
    // Encode length as 4 bytes
    const lengthBuffer = Buffer.alloc(4);
    lengthBuffer.writeUInt32BE(entries.length, 0);
    
    // Encode each key-value pair
    const encodedPairs: Buffer[] = [];
    for (const [key, value] of entries) {
      const keyBuffer = _encode(key);
      const valueBuffer = _encode(value);
      
      // Add size info for key and value
      const keyLengthBuffer = Buffer.alloc(4);
      keyLengthBuffer.writeUInt32BE(keyBuffer.length, 0);
      
      const valueLengthBuffer = Buffer.alloc(4);
      valueLengthBuffer.writeUInt32BE(valueBuffer.length, 0);
      
      encodedPairs.push(keyLengthBuffer, keyBuffer, valueLengthBuffer, valueBuffer);
    }
    
    return Buffer.concat([typeMarker, lengthBuffer, ...encodedPairs]);
  }

  // Fallback for unsupported types
  throw new Error(`Unsupported data type: ${typeof data}`);
}

/**
 * Decodes a Buffer back to its original data format
 * @param buffer The Buffer containing encoded data
 * @returns The decoded data
 */
export function decode(buffer: Buffer | { type: 'Buffer', data: number[] }): unknown {  
  // Convert buffer-like object to actual Buffer if needed
  const actualBuffer = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer.data);
  
  if (actualBuffer.length === 0) {
    throw new Error('Empty buffer cannot be decoded');
  }

  const typeMarker = actualBuffer[0];
  const contentBuffer = actualBuffer.subarray(1);

  switch (typeMarker) {
    case 0: // null or undefined
      return null;

    case 1: // string
      return contentBuffer.toString('utf-8');

    case 2: // number
      return Number(contentBuffer.toString('utf-8'));

    case 3: // boolean
      return contentBuffer.toString('utf-8') === '1';

    case 4: // bigint
      return BigInt(contentBuffer.toString('utf-8'));

    case 5: // Buffer
      return contentBuffer;

    case 6: // Date
      return new Date(Number(contentBuffer.toString('utf-8')));

    case 7: { // Array
      let offset = 0;
      const length = contentBuffer.readUInt32BE(offset);
      offset += 4;

      const result = [];
      for (let i = 0; i < length; i++) {
        const elementSize = contentBuffer.readUInt32BE(offset);
        offset += 4;
        
        const elementBuffer = contentBuffer.subarray(offset, offset + elementSize);
        offset += elementSize;
        
        result.push(decode(elementBuffer));
      }
      
      return result;
    }

    case 8: { // Object
      let offset = 0;
      const length = contentBuffer.readUInt32BE(offset);
      offset += 4;

      const result: Record<string, unknown> = {};
      for (let i = 0; i < length; i++) {
        // Read key
        const keySize = contentBuffer.readUInt32BE(offset);
        offset += 4;
        
        const keyBuffer = contentBuffer.subarray(offset, offset + keySize);
        offset += keySize;
        
        const key = decode(keyBuffer) as string;
        
        // Read value
        const valueSize = contentBuffer.readUInt32BE(offset);
        offset += 4;
        
        const valueBuffer = contentBuffer.subarray(offset, offset + valueSize);
        offset += valueSize;
        
        const value = decode(valueBuffer);
        
        result[key] = value;
      }
      
      return result;
    }

    default:
      throw new Error(`Unknown type marker: ${typeMarker}`);
  }
}
